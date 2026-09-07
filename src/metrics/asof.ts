import type { Db } from '../db/index.js';
import {
  appFilter,
  asOfPredicate,
  componentClauses,
  COUNT_SUBSCRIBERS,
  gateColumn,
  type AsOfOptions,
  type Fragment,
} from './predicate.js';
import {
  appIdFilter,
  rollupReady,
  splitBuckets,
  splitCte,
  toHalfOpen,
  type BucketSplit,
} from './rollup.js';
import {
  appIdIn,
  NO_COVERAGE,
  rawInstantCte,
  snapshotCte,
  splitInstants,
  stockCoverage,
  type StockCoverage,
} from './stockRollup.js';
import { addDayKey, dayKeyOf, type Bucket } from './time.js';
import { PLAN_CHANGE_WINDOW_SECONDS } from '../sync/derive.js';

/**
 * The as-of reconstruction engine (spec 2).
 *
 * Every stock figure answers "which subscriptions were live at instant D", using
 * the single predicate defined in `asOfPredicate`. It used to answer that by
 * scanning the raw tables once per bucket, which meant a twelve-point series
 * crossed `subscriptions`, `install_intervals` or `customer_events` twelve
 * times. It now answers it from a daily snapshot wherever the instant asked
 * about is one the snapshot holds — a local midnight, which is what every bucket
 * boundary except the last one is — and falls back to the raw scan for the rest.
 * `metrics/stockRollup.ts` is that rule; the raw halves below are unchanged.
 *
 * Because the snapshot is rebuilt rather than adjusted, a backdated cancellation
 * still corrects every past point automatically; it just does so in the sync
 * worker instead of on the request thread.
 *
 * Everything below binds values as named parameters. SQLite forbids mixing
 * named and positional binds, so the whole module uses `@name` consistently.
 */

export { asOfPredicate };
export type { AsOfOptions, Fragment };

const MS_PER_DAY = 86_400_000;

/**
 * Assemble the snapshot half and the raw half of one series into a single
 * statement.
 *
 * The two halves cover disjoint sets of buckets — an instant is a midnight the
 * snapshot holds or it is not — so no bucket is counted twice and none is
 * missed, and the union needs no re-aggregation on top. Either half may be
 * empty; a query with no buckets on one side simply does not contain it, which
 * is also why neither half needs a sentinel row.
 */
function unionParts(parts: string[], ctes: string[]): string {
  const body = parts.join('\nUNION ALL\n');
  return `${ctes.length > 0 ? `WITH ${ctes.join(', ')}\n` : ''}SELECT * FROM (\n${body}\n) ORDER BY idx`;
}

/** The as-of instants of a bucket list, indexed the way the reports expect. */
function instantsOf(buckets: Bucket[], pick: (bucket: Bucket) => Date): Array<{
  idx: number;
  asOf: Date;
}> {
  return buckets.map((bucket, idx) => ({ idx, asOf: pick(bucket) }));
}

/**
 * Builds a `buckets` CTE plus its bound parameters. Every per-bucket query
 * joins against this rather than issuing one query per point, which keeps even
 * a two-year daily series to a single round trip.
 *
 * Columns: `as_of` is the instant stock metrics are read at (the bucket's
 * exclusive end), `bucket_from` its inclusive start for flow metrics, and
 * `trailing_30` the start of a 30-day window ending at `as_of`.
 */
export function bucketsCte(buckets: Bucket[]): Fragment {
  const params: Record<string, unknown> = {};
  const rows = buckets.map((bucket, idx) => {
    params[`bi${idx}`] = idx;
    params[`ba${idx}`] = bucket.end.toISOString();
    params[`bt${idx}`] = new Date(bucket.end.getTime() - 30 * MS_PER_DAY).toISOString();
    params[`bf${idx}`] = bucket.start.toISOString();
    return `(@bi${idx}, @ba${idx}, @bt${idx}, @bf${idx})`;
  });
  return {
    sql: `buckets(idx, as_of, trailing_30, bucket_from) AS (VALUES ${rows.join(', ')})`,
    params,
  };
}

/**
 * Metered usage as a monthly rate, recognized across the term each payment
 * bought rather than summed inside a fixed 30-day window.
 *
 * Usage is billed in arrears and lumpy, so a single instant says nothing and
 * some window is unavoidable. A 30-day one is right for genuinely metered
 * consumption — that *is* the month's spend. It is wrong for a payment that
 * bought a year: an annual amount collected through one usage charge lands in
 * the window whole, reports twelve months of revenue as one month of run rate,
 * and then vanishes thirty days later, so neither the spike nor the cliff is a
 * rate anybody has.
 *
 * So each payment carries its own term. A charge on a monthly arrangement is
 * recognized at its full amount for thirty days, exactly as before. A charge on
 * an annual one is recognized at a twelfth of itself for a year — the same
 * normalization `monthly_amount` applies to an annual subscription price, and
 * for the same reason.
 *
 * The term comes from the subscription the shop held when the charge landed,
 * because usage carries no charge id of its own and can only be attributed by
 * shop-and-app. Two conditions, and the second is the one that keeps the rule
 * honest:
 *
 *   - the plan bills annually, and
 *   - the plan's own recurring price is zero.
 *
 * A zero-priced plan is *paid through* its usage charge — that is the whole
 * billing mechanism — so on an annual one the charge is the year's payment. A
 * plan that carries a price is already paying for itself, and metered spend on
 * top of it is consumption in the month it happened, whatever cadence the
 * subscription renews on. Without the second condition an annual subscriber's
 * ordinary metered usage was being smeared across twelve months too, which
 * understates the month it was actually consumed in and keeps it on the books
 * for a year after.
 *
 * A shop holding both an annual and a monthly plan at once resolves to annual;
 * there is no way to tell which of the two a usage charge was raised against,
 * and the codebase would rather amortize than overstate.
 */
function usageRecognized(appIds: string[], prefix: string): Fragment {
  const apps = appFilter(appIds, 't.app_id', prefix);
  const onAnnualPlan = `EXISTS (
                SELECT 1 FROM subscriptions s
                 WHERE s.app_id = t.app_id
                   AND s.shop_id = t.shop_id
                   AND s.is_test = 0
                   AND s.billing_interval = 'ANNUAL'
                   -- Paid through usage rather than through its own price.
                   AND s.amount <= 0
                   AND s.activated_at IS NOT NULL
                   AND s.activated_at <= t.created_at
                   AND (s.churn_at IS NULL OR s.churn_at > t.created_at)
              )`;
  // Rebuilt in the canonical ISO shape the rest of the store uses, so the
  // half-open comparisons below stay lexical. SQLite's own `datetime()` would
  // hand back "YYYY-MM-DD HH:MM:SS", which sorts nowhere near it.
  const through = (days: number) =>
    `strftime('%Y-%m-%dT%H:%M:%fZ', t.created_at, '+${days} day')`;

  return {
    sql: `usage_recognized AS (
         SELECT t.app_id AS app_id,
                t.shop_id AS shop_id,
                t.created_at AS created_at,
                CASE WHEN ${onAnnualPlan} THEN t.gross_amount / 12.0 ELSE t.gross_amount END
                  AS monthly_amount,
                CASE WHEN ${onAnnualPlan} THEN ${through(365)} ELSE ${through(30)} END
                  AS through
         FROM transactions t
         WHERE t.type = 'AppUsageSale'
         ${apps.sql ? `AND ${apps.sql}` : ''}
       )`,
    params: apps.params,
  };
}

/** "This payment is still being recognized as of <instant>". */
const LIVE_USAGE = (instant: string) => `u.created_at <= ${instant} AND u.through > ${instant}`;

export interface StockPoint {
  idx: number;
  asOf: string;
  monthlyMrr: number;
  annualMrr: number;
  subscriptions: number;
  subscribers: number;
}

/**
 * One aggregation per bucket over the as-of-live set. Returns the recurring
 * components; usage and trial add-ons are composed on top by the MRR report.
 *
 * The buckets whose as-of instant is a stored midnight read four sums out of
 * `subscription_daily`; the rest keep the join against the raw table. How the
 * two as-of flags are served is the whole of the table's design:
 *
 *  - **`includeTrials` picks the row.** It swaps the predicate's gate, so it
 *    selects a different population rather than a subset of one, and the
 *    snapshot stores a row per gate. Nothing here adds the two together.
 *  - **`includeAnnual` picks the columns.** It is a filter on a row attribute,
 *    so the annual and non-annual halves are stored apart and only the wanted
 *    ones are summed — except for the subscriber count, which is a distinct
 *    count and does not survive being added across the split, and is therefore
 *    stored once per answer.
 */
/**
 * The rollup coverage a component-filtered request may use.
 *
 * `subscription_daily` is keyed on the trials gate alone, so it can answer "with
 * trials" and "without" and nothing finer. Trials *on their own* is a third
 * question: it needs subscriptions that have activated and not yet converted at
 * the same instant, which no stored column holds. The two gates cannot be
 * differenced into it either — a shop holding one converted and one trialling
 * charge sits in both, so the distinct subscriber counts would cancel to zero
 * rather than to one.
 *
 * So a narrowed request declines the rollup and reads the subscription rows.
 * Slower, and only on a view that asks for it; the alternative is a fast wrong
 * answer.
 */
function coverageFor(db: Db, options: AsOfOptions): StockCoverage {
  return options.includeSubscriptions === false ? NO_COVERAGE : stockCoverage(db);
}

export function stockSeries(
  db: Db,
  buckets: Bucket[],
  options: AsOfOptions,
  timeZone: string,
): StockPoint[] {
  const split = splitInstants(
    instantsOf(buckets, (bucket) => bucket.end),
    timeZone,
    coverageFor(db, options),
  );
  const ctes: string[] = [];
  const parts: string[] = [];
  const params: Record<string, unknown> = {};

  if (split.snapshots.length > 0) {
    const cte = snapshotCte(split.snapshots, 'sbuckets', 'sb');
    const apps = appIdIn(options.appIds, 'r.app_id', 'sbapp');
    ctes.push(cte.sql);
    Object.assign(params, cte.params, apps.params, { sbGate: options.includeTrials ? 1 : 0 });
    parts.push(
      `SELECT b.idx AS idx,
              b.as_of AS asOf,
              COALESCE(SUM(r.monthly_mrr), 0) AS monthlyMrr,
              COALESCE(SUM(${options.includeAnnual ? 'r.annual_mrr' : '0'}), 0) AS annualMrr,
              COALESCE(SUM(r.monthly_subs${options.includeAnnual ? ' + r.annual_subs' : ''}), 0) AS subscriptions,
              COALESCE(SUM(${options.includeAnnual ? 'r.subscribers_all' : 'r.subscribers_monthly'}), 0) AS subscribers
       FROM sbuckets b
       LEFT JOIN subscription_daily r
         ON r.day = b.day AND r.gate = @sbGate
        ${apps.sql ? `AND ${apps.sql}` : ''}
       GROUP BY b.idx, b.as_of`,
    );
  }

  if (split.raw.length > 0) {
    const cte = rawInstantCte(split.raw, 'rbuckets', 'rb');
    const predicate = asOfPredicate(options, 'b.as_of');
    ctes.push(cte.sql);
    Object.assign(params, cte.params, predicate.params);
    parts.push(
      `SELECT b.idx AS idx,
              b.as_of AS asOf,
              COALESCE(SUM(CASE WHEN s.billing_interval <> 'ANNUAL' THEN s.monthly_amount ELSE 0 END), 0) AS monthlyMrr,
              COALESCE(SUM(CASE WHEN s.billing_interval =  'ANNUAL' THEN s.monthly_amount ELSE 0 END), 0) AS annualMrr,
              COUNT(s.charge_id) AS subscriptions,
              ${COUNT_SUBSCRIBERS} AS subscribers
       FROM rbuckets b
       LEFT JOIN subscriptions s
         ON ${predicate.sql}
       GROUP BY b.idx, b.as_of`,
    );
  }

  if (parts.length === 0) return [];
  return db.prepare(unionParts(parts, ctes)).all(params) as StockPoint[];
}

export interface AppStockPoint {
  idx: number;
  appId: string;
  appName: string | null;
  mrr: number;
}

/**
 * The same as-of reconstruction as `stockSeries`, split by the app that earns
 * the revenue. One extra GROUP BY column rather than a query per app, so the
 * per-app figures are guaranteed to sum to the total.
 */
export function stockSeriesByApp(
  db: Db,
  buckets: Bucket[],
  options: AsOfOptions,
  timeZone: string,
): AppStockPoint[] {
  const split = splitInstants(
    instantsOf(buckets, (bucket) => bucket.end),
    timeZone,
    coverageFor(db, options),
  );
  const ctes: string[] = [];
  const parts: string[] = [];
  const params: Record<string, unknown> = {};

  if (split.snapshots.length > 0) {
    const cte = snapshotCte(split.snapshots, 'abuckets', 'ab');
    const apps = appIdIn(options.appIds, 'r.app_id', 'abapp');
    ctes.push(cte.sql);
    Object.assign(params, cte.params, apps.params, { abGate: options.includeTrials ? 1 : 0 });
    // The raw form is an inner join, so an app with nothing live produces no
    // row at all. With `includeAnnual` off, an app holding only annual charges
    // is exactly that case even though the snapshot has a row for it, which is
    // what the `monthly_subs > 0` test reproduces.
    parts.push(
      `SELECT b.idx AS idx,
              r.app_id AS appId,
              a.name AS appName,
              COALESCE(SUM(r.monthly_mrr${options.includeAnnual ? ' + r.annual_mrr' : ''}), 0) AS mrr
       FROM abuckets b
       JOIN subscription_daily r
         ON r.day = b.day AND r.gate = @abGate
        ${options.includeAnnual ? '' : 'AND r.monthly_subs > 0'}
        ${apps.sql ? `AND ${apps.sql}` : ''}
       LEFT JOIN apps a ON a.id = r.app_id
       GROUP BY b.idx, r.app_id, a.name`,
    );
  }

  if (split.raw.length > 0) {
    const cte = rawInstantCte(split.raw, 'rabuckets', 'ra');
    const predicate = asOfPredicate(options, 'b.as_of');
    ctes.push(cte.sql);
    Object.assign(params, cte.params, predicate.params);
    parts.push(
      `SELECT b.idx AS idx,
              s.app_id AS appId,
              a.name AS appName,
              COALESCE(SUM(s.monthly_amount), 0) AS mrr
       FROM rabuckets b
       JOIN subscriptions s
         ON ${predicate.sql}
       LEFT JOIN apps a ON a.id = s.app_id
       GROUP BY b.idx, s.app_id, a.name`,
    );
  }

  if (parts.length === 0) return [];
  return db.prepare(unionParts(parts, ctes)).all(params) as AppStockPoint[];
}

/**
 * The same trailing-30-day usage rate as `usageSeries`, split by the app that
 * earned it. No attribution guesswork here, unlike the per-plan split: a usage
 * sale names its app outright.
 */
export function usageSeriesByApp(
  db: Db,
  buckets: Bucket[],
  appIds: string[],
): Array<{ idx: number; appId: string; appName: string | null; usage: number }> {
  const cte = bucketsCte(buckets);
  const usage = usageRecognized(appIds, 'uaapp');

  return db
    .prepare(
      `WITH ${cte.sql},
       ${usage.sql}
       SELECT b.idx AS idx,
              u.app_id AS appId,
              a.name AS appName,
              COALESCE(SUM(u.monthly_amount), 0) AS usage
       FROM buckets b
       JOIN usage_recognized u
         ON ${LIVE_USAGE('b.as_of')}
       LEFT JOIN apps a ON a.id = u.app_id
       GROUP BY b.idx, u.app_id, a.name
       ORDER BY b.idx`,
    )
    .all({ ...cte.params, ...usage.params }) as Array<{
    idx: number;
    appId: string;
    appName: string | null;
    usage: number;
  }>;
}

export interface PlanStockPoint {
  idx: number;
  appId: string;
  appName: string | null;
  /** The charge's name as Shopify recorded it, or NULL if it carried none. */
  planName: string | null;
  mrr: number;
  subscriptions: number;
}

/**
 * The same as-of reconstruction as `stockSeries`, split by the plan a
 * subscription is on. Same predicate, one more GROUP BY column, so the per-plan
 * figures sum to the total by construction rather than by agreement.
 *
 * Grouped by app *and* plan, never by plan alone. A plan name is the charge name
 * the app itself chose, so two apps in one organization can both sell a "BASIC"
 * without those being the same product; folding them into one row would invent a
 * plan neither app sells. The report labels the rows with the app when more than
 * one is in scope, and drops the prefix when there is nothing to disambiguate.
 *
 * NULL plan names group together — SQLite treats them as one group — which is
 * the honest reading: a charge that arrived without a name tells us nothing
 * about which plan it was, and every such charge tells us the same nothing.
 */
export function stockSeriesByPlan(
  db: Db,
  buckets: Bucket[],
  options: AsOfOptions,
): PlanStockPoint[] {
  const cte = bucketsCte(buckets);
  const predicate = asOfPredicate(options, 'b.as_of');

  return db
    .prepare(
      `WITH ${cte.sql}
       SELECT b.idx AS idx,
              s.app_id AS appId,
              a.name AS appName,
              s.plan_name AS planName,
              COALESCE(SUM(s.monthly_amount), 0) AS mrr,
              COUNT(s.charge_id) AS subscriptions
       FROM buckets b
       JOIN subscriptions s
         ON ${predicate.sql}
       LEFT JOIN apps a ON a.id = s.app_id
       GROUP BY b.idx, s.app_id, a.name, s.plan_name
       ORDER BY b.idx`,
    )
    .all({ ...cte.params, ...predicate.params }) as PlanStockPoint[];
}

export interface UsagePlanPoint {
  idx: number;
  appId: string;
  appName: string | null;
  /** The plan in force for the shop that consumed it, when one was. */
  planName: string | null;
  /** 0 when the pair held no live subscription at the bucket's end. */
  hasPlan: number;
  usage: number;
}

/**
 * Metered usage, split by the plan the consuming shop was on.
 *
 * Usage carries no charge of its own — the Partner API stamps an
 * `AppUsageRecord` id on the sale, never the subscription it belongs to — so
 * there is nothing to join a plan onto directly. It is attributed by
 * shop-and-app instead, exactly as `usageChurnCtes` attributes it: the plan is
 * whichever subscription that pair had live at the bucket's end.
 *
 * Read as a trailing-30-day rate, the same as `usageSeries`, so a per-plan
 * figure is comparable with the monthly subscription price beside it. Usage is
 * billed in arrears and lumpy; reading it at a single instant would be
 * meaningless whichever way it is split.
 *
 * Three deliberate choices, because each one could reasonably have gone the
 * other way:
 *
 *   - **The live predicate ignores the report's filters.** Trials and annual
 *     plans are included whatever the toggles say, because usage revenue is in
 *     the MRR total whatever they say. Attributing with the filtered predicate
 *     would strand a merchant's usage under "no plan" for the sole reason that
 *     the plan they are on is currently filtered out of the view.
 *   - **A pair with no live subscription is reported as such** (`hasPlan = 0`)
 *     rather than credited to the plan they used to hold. A shop consuming
 *     metered capacity after cancelling is a real thing that happens, and the
 *     plan they left is not earning it.
 *   - **One plan per pair, the most recently activated.** A shop holding two
 *     live charges has no fact of the matter about which one its usage belongs
 *     to; splitting the money between them would invent one. The newest charge
 *     is the plan the merchant is on today, which is the closest thing to an
 *     answer, and `charge_id` breaks a tie so the same book always reads the
 *     same way.
 */
export function usageSeriesByPlan(
  db: Db,
  buckets: Bucket[],
  options: AsOfOptions,
): UsagePlanPoint[] {
  const cte = bucketsCte(buckets);
  const usage = usageRecognized(options.appIds, 'upapp');
  const live = asOfPredicate(
    { ...options, includeSubscriptions: true, includeTrials: true, includeAnnual: true },
    'u.as_of',
  );
  const pair = `s.app_id = u.app_id AND s.shop_id = u.shop_id AND ${live.sql}`;

  return db
    .prepare(
      `WITH ${cte.sql},
       ${usage.sql},
       usage_pairs AS (
         SELECT b.idx AS idx,
                b.as_of AS as_of,
                u.app_id AS app_id,
                u.shop_id AS shop_id,
                COALESCE(SUM(u.monthly_amount), 0) AS amount
         FROM buckets b
         JOIN usage_recognized u
           ON ${LIVE_USAGE('b.as_of')}
         GROUP BY b.idx, b.as_of, u.app_id, u.shop_id
       ),
       attributed AS (
         SELECT u.idx AS idx,
                u.app_id AS app_id,
                u.amount AS amount,
                (SELECT s.plan_name FROM subscriptions s
                  WHERE ${pair}
                  ORDER BY COALESCE(s.activated_at, '') DESC, s.charge_id DESC
                  LIMIT 1) AS plan_name,
                EXISTS (SELECT 1 FROM subscriptions s WHERE ${pair}) AS has_plan
         FROM usage_pairs u
       )
       SELECT idx AS idx,
              app_id AS appId,
              (SELECT a.name FROM apps a WHERE a.id = attributed.app_id) AS appName,
              plan_name AS planName,
              has_plan AS hasPlan,
              COALESCE(SUM(amount), 0) AS usage
       FROM attributed
       GROUP BY idx, app_id, plan_name, has_plan
       ORDER BY idx`,
    )
    .all({ ...cte.params, ...usage.params, ...live.params }) as UsagePlanPoint[];
}

/**
 * Subscriptions that started paying inside each bucket (spec 4.6). A flow, and
 * gated on the same instant the stock metrics use, so a new subscription and the
 * MRR it brings appear in the same bucket.
 *
 * Plan changes are excluded for the same reason churn excludes them: Shopify
 * models an upgrade as a new charge, and counting those would report every
 * existing customer moving up a tier as a new one.
 *
 * Note which side of the pair carries the flag. `is_plan_change` marks the
 * charge that *ended*, because that is the one churn must not count. The
 * replacement carries nothing, so the exclusion here has to find it the same way
 * the derive step paired them — and *exactly* the same way, or this report and
 * the event ledger disagree about which activations were new. That is why the
 * window below is the derive step's own constant rather than a second setting.
 */
export function newSubscriptionSeries(
  db: Db,
  buckets: Bucket[],
  options: AsOfOptions,
  byShop: boolean,
): Map<number, number> {
  const cte = bucketsCte(buckets);
  const apps = appFilter(options.appIds, 's.app_id', 'napp');
  const gate = gateColumn(options.includeTrials);
  const countExpr = byShop ? COUNT_SUBSCRIBERS : 'COUNT(s.charge_id)';
  // The same component gate the stock series uses, read at the bucket's end: a
  // subscription is new in the bucket its gate instant falls in, and a
  // trials-only view counts the ones that had not converted by the time the
  // bucket closed.
  const components = componentClauses(options, 'b.as_of').map((clause) => `AND ${clause}`);

  const rows = db
    .prepare(
      `WITH ${cte.sql}
       SELECT b.idx AS idx, ${countExpr} AS value
       FROM buckets b
       LEFT JOIN subscriptions s
         ON s.is_test = 0
        ${apps.sql ? `AND ${apps.sql}` : ''}
        ${options.includeAnnual ? '' : `AND s.billing_interval <> 'ANNUAL'`}
        AND ${gate} IS NOT NULL
        AND ${gate} >= b.bucket_from
        AND ${gate} < b.as_of
        ${components.join('\n        ')}
        AND NOT EXISTS (
          SELECT 1 FROM subscriptions prior
          WHERE prior.app_id = s.app_id
            AND prior.shop_id = s.shop_id
            AND prior.charge_id <> s.charge_id
            AND prior.is_plan_change = 1
            AND prior.churn_at IS NOT NULL
            AND s.activated_at IS NOT NULL
            AND (julianday(s.activated_at) - julianday(prior.churn_at)) * 86400.0 >= 0
            AND (julianday(s.activated_at) - julianday(prior.churn_at)) * 86400.0
                  < @planChangeSeconds
        )
       GROUP BY b.idx
       ORDER BY b.idx`,
    )
    .all({
    ...cte.params,
    ...apps.params,
    planChangeSeconds: PLAN_CHANGE_WINDOW_SECONDS,
  }) as Array<{
    idx: number;
    value: number;
  }>;

  return new Map(rows.map((row) => [row.idx, row.value]));
}

/**
 * Subscriptions inside their free period as-of each bucket (spec 4.11).
 *
 * A trial is live at D when it had started by D and had neither ended nor been
 * cancelled by then. Trials whose outcome was never recorded — activated, never
 * billed, never cancelled, no billing date — have no end instant to test, so
 * they are excluded rather than counted as trialling forever.
 */
export function onTrialSeries(
  db: Db,
  buckets: Bucket[],
  appIds: string[],
  timeZone: string,
): Map<number, number> {
  const split = splitInstants(
    instantsOf(buckets, (bucket) => bucket.end),
    timeZone,
    stockCoverage(db),
  );
  const ctes: string[] = [];
  const parts: string[] = [];
  const params: Record<string, unknown> = {};

  if (split.snapshots.length > 0) {
    const cte = snapshotCte(split.snapshots, 'tbuckets', 'tb');
    const apps = appIdIn(appIds, 'p.app_id', 'tbapp');
    ctes.push(cte.sql);
    Object.assign(params, cte.params, apps.params);
    parts.push(
      `SELECT b.idx AS idx, COALESCE(SUM(p.on_trial), 0) AS value
       FROM tbuckets b
       LEFT JOIN population_daily p
         ON p.day = b.day
        ${apps.sql ? `AND ${apps.sql}` : ''}
       GROUP BY b.idx`,
    );
  }

  if (split.raw.length > 0) {
    const cte = rawInstantCte(split.raw, 'rtbuckets', 'rt');
    const apps = appFilter(appIds, 's.app_id', 'otapp');
    ctes.push(cte.sql);
    Object.assign(params, cte.params, apps.params);
    parts.push(
      `SELECT b.idx AS idx, COUNT(s.charge_id) AS value
       FROM rtbuckets b
       LEFT JOIN subscriptions s
         ON s.is_test = 0
        ${apps.sql ? `AND ${apps.sql}` : ''}
        AND s.trial_started_at IS NOT NULL
        AND s.trial_ends_at IS NOT NULL
        AND s.trial_started_at < b.as_of
        AND s.trial_ends_at >= b.as_of
        AND (s.churn_at IS NULL OR s.churn_at >= b.as_of)
       GROUP BY b.idx`,
    );
  }

  if (parts.length === 0) return new Map();
  const rows = db.prepare(unionParts(parts, ctes)).all(params) as Array<{
    idx: number;
    value: number;
  }>;
  return new Map(rows.map((row) => [row.idx, row.value]));
}

const USAGE_TYPE = 'AppUsageSale';

/**
 * Metered usage revenue attributed to each bucket as a trailing-30-day rate, so
 * it is comparable with a monthly subscription figure. Usage is billed in
 * arrears and lumpy; reading it at a single instant would be meaningless.
 *
 * Twelve trailing-30-day windows over the raw ledger is twelve overlapping
 * range scans of the largest table in the database, which is why MRR was the
 * second most expensive metric on the dashboard despite the subscription half of
 * it being a cheap read of a small table. The windows are served out of the
 * daily rollup instead, with only their sub-day ends coming from the raw rows —
 * twenty-nine or thirty of each window's thirty days are whole.
 *
 * The window is `(trailing_30, as_of]` rather than `[from, to)` like every other
 * window here, and that asymmetry is preserved exactly: `toHalfOpen` shifts both
 * ends by a millisecond, which selects the identical set of rows over
 * millisecond-precision timestamps. See its comment.
 */
/*
 * Deliberately not on the daily rollup, unlike every other series here.
 *
 * The rollup stores one gross total per day and type, which is all a trailing
 * 30-day sum needs and not enough for this: recognizing a payment across the
 * term it bought needs that payment's own term, and the term comes from the
 * subscription the shop held when the charge landed. Summing the rollup instead
 * would be faster and would answer the older question — the one this function
 * exists to stop answering.
 */
export function usageSeries(db: Db, buckets: Bucket[], appIds: string[]): Map<number, number> {
  const cte = bucketsCte(buckets);
  const usage = usageRecognized(appIds, 'uapp');

  const rows = db
    .prepare(
      `WITH ${cte.sql},
       ${usage.sql}
       SELECT b.idx AS idx, COALESCE(SUM(u.monthly_amount), 0) AS value
       FROM buckets b
       LEFT JOIN usage_recognized u
         ON ${LIVE_USAGE('b.as_of')}
       GROUP BY b.idx
       ORDER BY b.idx`,
    )
    .all({ ...cte.params, ...usage.params }) as Array<{ idx: number; value: number }>;

  return new Map(rows.map((row) => [row.idx, row.value]));
}

/**
 * Active installs as-of each bucket (spec 4.5). An install is live when some
 * half-open interval covers the instant, which is why sync collapses the
 * install/uninstall/reinstall stream into intervals up front.
 */
export function activeInstallSeries(
  db: Db,
  buckets: Bucket[],
  appIds: string[],
  timeZone: string,
): Map<number, number> {
  const split = splitInstants(
    instantsOf(buckets, (bucket) => bucket.end),
    timeZone,
    stockCoverage(db),
  );
  const ctes: string[] = [];
  const parts: string[] = [];
  const params: Record<string, unknown> = {};

  if (split.snapshots.length > 0) {
    const cte = snapshotCte(split.snapshots, 'ibuckets', 'ib');
    const apps = appIdIn(appIds, 'p.app_id', 'ibapp');
    ctes.push(cte.sql);
    Object.assign(params, cte.params, apps.params);
    // A distinct count of shop-and-app pairs is additive across apps, which is
    // why one stored count per app answers every app scope.
    parts.push(
      `SELECT b.idx AS idx, COALESCE(SUM(p.active_installs), 0) AS value
       FROM ibuckets b
       LEFT JOIN population_daily p
         ON p.day = b.day
        ${apps.sql ? `AND ${apps.sql}` : ''}
       GROUP BY b.idx`,
    );
  }

  if (split.raw.length > 0) {
    const cte = rawInstantCte(split.raw, 'ribuckets', 'ri');
    const apps = appFilter(appIds, 'i.app_id', 'iapp');
    ctes.push(cte.sql);
    Object.assign(params, cte.params, apps.params);
    parts.push(
      `SELECT b.idx AS idx, COUNT(DISTINCT i.app_id || ' ' || i.shop_id) AS value
       FROM ribuckets b
       LEFT JOIN install_intervals i
         ON i.started_at <= b.as_of
        AND (i.ended_at IS NULL OR i.ended_at > b.as_of)
        ${apps.sql ? `AND ${apps.sql}` : ''}
       GROUP BY b.idx`,
    );
  }

  if (parts.length === 0) return new Map();
  const rows = db.prepare(unionParts(parts, ctes)).all(params) as Array<{
    idx: number;
    value: number;
  }>;
  return new Map(rows.map((row) => [row.idx, row.value]));
}

/** Recurring MRR at a single instant, used for churn denominators and LTV. */
export function mrrAt(db: Db, asOf: Date, options: AsOfOptions): number {
  const predicate = asOfPredicate(options, '@asOf');
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(s.monthly_amount), 0) AS value
       FROM subscriptions s
       WHERE ${predicate.sql}`,
    )
    .get({ ...predicate.params, asOf: asOf.toISOString() }) as { value: number };
  return row.value;
}

/** Active population at a single instant, by subscriber or by subscription. */
export function populationAt(db: Db, asOf: Date, options: AsOfOptions, byShop: boolean): number {
  const predicate = asOfPredicate(options, '@asOf');
  const expression = byShop ? COUNT_SUBSCRIBERS : 'COUNT(s.charge_id)';
  const row = db
    .prepare(
      `SELECT ${expression} AS value
       FROM subscriptions s
       WHERE ${predicate.sql}`,
    )
    .get({ ...predicate.params, asOf: asOf.toISOString() }) as { value: number };
  return row.value;
}

export interface ChurnPoint {
  idx: number;
  /** Population alive at the start of the rolling window. */
  population: number;
  /** MRR alive at the start of the rolling window. */
  baseMrr: number;
  churned: number;
  lostMrr: number;
}

interface UsageChurn {
  sql: string;
  joins: string;
  params: Record<string, unknown>;
  basePairs: string;
  baseAmount: string;
  lostPairs: string;
  lostAmount: string;
}

/**
 * Metered usage, on both sides of the churn ratio.
 *
 * Usage carries no subscription of its own — the Partner API stamps an
 * `AppUsageRecord` id on the sale, not the charge it belongs to — so it cannot
 * be gated by the as-of predicate. It is attributed by shop-and-app instead,
 * and the loss event is the one thing that is unambiguous: the pair had a live
 * subscription when the window opened and has none by the time it closes.
 *
 * Consumption is deliberately *not* the signal. Metered spend is lumpy — most
 * shops bill in one or two months of their life — so "stopped consuming" would
 * report most of the base churning every month and mean nothing.
 *
 * Money and counts dedupe differently, which is the subtle part:
 *
 *   - Money never dedupes. A shop's usage is revenue on top of its subscription
 *     price, so it belongs in the base and in the loss whether or not that
 *     shop's charge is already counted.
 *   - Counts always dedupe. A pair already inside the recurring population is
 *     one relationship, not two, so it only adds a head when the component
 *     filter has left it out — which is what makes "usage only" report a
 *     population instead of a zero, while the default view's counts do not move.
 */
function usageChurnCtes(options: AsOfOptions): UsageChurn {
  const none: UsageChurn = {
    sql: '',
    joins: '',
    params: {},
    basePairs: '0',
    baseAmount: '0',
    lostPairs: '0',
    lostAmount: '0',
  };
  if (!options.includeUsage) return none;

  const recognized = usageRecognized(options.appIds, 'cuapp');
  // The component-filtered population, to dedupe counts against.
  const counted = asOfPredicate(options, 'u.window_start');
  // Any live relationship at all, trials included, which is what decides
  // whether the pair is still a customer. Deliberately not the filtered
  // predicate: under "usage only" that one matches nothing, and every pair
  // would read as churned.
  const anyLive = (expr: string) =>
    asOfPredicate({ ...options, includeSubscriptions: true, includeTrials: true }, expr);
  const stillLive = anyLive('u.as_of');
  const wasLive = anyLive('u.window_start');

  const pairOf = (predicateSql: string) =>
    `SELECT 1 FROM subscriptions s
              WHERE s.app_id = u.app_id AND s.shop_id = u.shop_id AND ${predicateSql}`;
  /**
   * A head the recurring base has not already counted, and only for a pair that
   * was still a customer when the window opened — the same rule the recurring
   * base follows, because what cannot churn cannot sit in the denominator.
   * Without the second half a shop that left last month lingers here until its
   * usage ages out of the trailing 30 days, understating churn for a month.
   */
  const countable = `CASE WHEN NOT EXISTS (${pairOf(counted.sql)})
                           AND EXISTS (${pairOf(wasLive.sql)}) THEN 1 ELSE 0 END`;

  return {
    params: { ...recognized.params, ...counted.params, ...stillLive.params, ...wasLive.params },
    basePairs: 'COALESCE(ub.pairs, 0)',
    baseAmount: 'COALESCE(ub.amount, 0)',
    lostPairs: 'COALESCE(ul.pairs, 0)',
    lostAmount: 'COALESCE(ul.amount, 0)',
    joins: `LEFT JOIN usage_base ub ON ub.idx = base.idx
       LEFT JOIN usage_lost ul ON ul.idx = base.idx`,
    sql: `${recognized.sql},
       usage_at_start AS (
         SELECT b.idx AS idx,
                b.as_of AS as_of,
                b.window_start AS window_start,
                u.app_id AS app_id,
                u.shop_id AS shop_id,
                COALESCE(SUM(u.monthly_amount), 0) AS amount
         FROM cbuckets b
         -- The rate being recognized when the window opened, which is what the
         -- MRR the ratio divides was reading at that instant.
         JOIN usage_recognized u
           ON ${LIVE_USAGE('b.window_start')}
         GROUP BY b.idx, b.as_of, b.window_start, u.app_id, u.shop_id
       ),
       usage_base AS (
         SELECT u.idx AS idx,
                COALESCE(SUM(u.amount), 0) AS amount,
                COALESCE(SUM(${countable}), 0) AS pairs
         FROM usage_at_start u
         GROUP BY u.idx
       ),
       usage_lost AS (
         SELECT u.idx AS idx,
                COALESCE(SUM(u.amount), 0) AS amount,
                COALESCE(SUM(${countable}), 0) AS pairs
         FROM usage_at_start u
         WHERE EXISTS (${pairOf(wasLive.sql)})
           AND NOT EXISTS (${pairOf(stillLive.sql)})
         GROUP BY u.idx
       ),`,
  };
}

/**
 * Rolling-window churn (spec 4.7).
 *
 * The denominator is the start-of-window base, never the end-of-window one, or
 * churn is understated exactly when a business is shrinking. Only subscriptions
 * that were already live at the window start can count as churned inside it.
 *
 * Plan changes are excluded: Shopify models an upgrade as cancel-old plus
 * create-new, so counting raw cancels would report every upgrade as a lost
 * customer.
 *
 * Usage joins both sides when it is in scope (see `usageChurnCtes`), because a
 * churn rate whose denominator excludes revenue the MRR card includes is
 * measuring a different business than the one on screen.
 */
export function churnSeries(
  db: Db,
  buckets: Bucket[],
  options: AsOfOptions,
  windowDays: number,
  byShop: boolean,
): ChurnPoint[] {
  const params: Record<string, unknown> = {};
  const rows = buckets.map((bucket, idx) => {
    params[`ci${idx}`] = idx;
    params[`ca${idx}`] = bucket.end.toISOString();
    const windowStart = new Date(bucket.end.getTime() - windowDays * MS_PER_DAY);
    params[`cw${idx}`] = windowStart.toISOString();
    // Usage is read as a trailing-30-day rate wherever it appears, so the base
    // rate is the 30 days before the window opened.
    params[`cu${idx}`] = new Date(windowStart.getTime() - 30 * MS_PER_DAY).toISOString();
    return `(@ci${idx}, @ca${idx}, @cw${idx}, @cu${idx})`;
  });

  const predicate = asOfPredicate(options, 'b.window_start');
  const countExpr = byShop ? COUNT_SUBSCRIBERS : 'COUNT(s.charge_id)';
  const usage = usageChurnCtes(options);

  return db
    .prepare(
      `WITH cbuckets(idx, as_of, window_start, usage_from) AS (VALUES ${rows.join(', ')}),
       ${usage.sql}
       base AS (
         SELECT b.idx AS idx,
                ${countExpr} AS population,
                COALESCE(SUM(s.monthly_amount), 0) AS baseMrr
         FROM cbuckets b
         LEFT JOIN subscriptions s ON ${predicate.sql}
         GROUP BY b.idx
       ),
       lost AS (
         SELECT b.idx AS idx,
                ${countExpr} AS churned,
                COALESCE(SUM(s.monthly_amount), 0) AS lostMrr
         FROM cbuckets b
         LEFT JOIN subscriptions s
         -- The same predicate the base uses, so the two sides cannot disagree
         -- about who was live when the window opened. Re-deriving a partial
         -- copy of it here is what let an annual plan excluded from the base,
         -- or a subscription already frozen out of it, still be counted as a
         -- loss against it. The predicate also supplies the lower bound on
         -- churn_at: paired with IS NOT NULL it means "cancelled at or after
         -- the window opened".
           ON ${predicate.sql}
          AND s.is_plan_change = 0
          AND s.churn_at IS NOT NULL
          AND s.churn_at < b.as_of
         GROUP BY b.idx
       )
       SELECT base.idx AS idx,
              base.population + ${usage.basePairs} AS population,
              base.baseMrr + ${usage.baseAmount} AS baseMrr,
              lost.churned + ${usage.lostPairs} AS churned,
              lost.lostMrr + ${usage.lostAmount} AS lostMrr
       FROM base
       JOIN lost ON lost.idx = base.idx
       ${usage.joins}
       ORDER BY base.idx`,
    )
    .all({ ...params, ...predicate.params, ...usage.params }) as ChurnPoint[];
}

/** Monthly churn rate as a fraction, guarded against an empty base. */
export function churnRate(point: ChurnPoint | undefined): number {
  if (!point || point.population <= 0) return 0;
  return point.churned / point.population;
}

export interface InstallChurnPoint {
  idx: number;
  /** Active installs at the instant the rolling window opened. */
  population: number;
  /** Uninstall and deactivation events inside the window. */
  uninstalled: number;
  /** Reinstall and reactivation events inside the window. */
  reinstalled: number;
}

/**
 * Rolling-window logo churn (spec 4.7): `(uninstalls − reinstalls) ÷ active
 * installs at the window start`.
 *
 * It reads the install ledger, not the subscription index, and that is the
 * whole reason it is a separate metric. A free install that never paid is a
 * logo; a shop that cancels but keeps the app installed has not churned as one.
 * Counting logos off `subscriptions` makes this metric a copy of subscription
 * churn — identical SQL over identical rows — which is exactly what it was.
 *
 * Deactivation counts as an uninstall and reactivation as a return, per spec
 * 4.5 ("deactivation == uninstall unless reactivated") and the net-install
 * formula in 4.6. Movement is counted in events, so a shop that uninstalls
 * twice inside one window counts twice, matching how growth reads the same
 * ledger.
 */
export function installChurnSeries(
  db: Db,
  buckets: Bucket[],
  appIds: string[],
  windowDays: number,
  timeZone: string,
): InstallChurnPoint[] {
  const coverage = stockCoverage(db);
  const params: Record<string, unknown> = {};
  const ctes: string[] = [];

  /*
   * Logo churn is the one metric that needs both shapes of rollup at once, and
   * it is the clearest illustration of why there are two.
   *
   * Its denominator is a *stock* — installs live at the instant the window
   * opened — and comes from `population_daily` by the midnight rule. Its
   * numerator is a *flow* — uninstalls and reinstalls inside the window — and
   * comes from `customer_event_daily` the way the money rollup serves a window:
   * whole days from the rollup, sub-day remainders from the raw table. The event
   * ledger is the largest table in the database, and crossing it once per bucket
   * with a thirty-day window was the most expensive read left on this side.
   */
  const baseParts: string[] = [];
  const baseSplit = splitInstants(
    buckets.map((bucket, idx) => ({
      idx,
      asOf: new Date(bucket.end.getTime() - windowDays * MS_PER_DAY),
    })),
    timeZone,
    coverage,
  );

  if (baseSplit.snapshots.length > 0) {
    const cte = snapshotCte(baseSplit.snapshots, 'lbase', 'lb');
    const apps = appIdIn(appIds, 'p.app_id', 'lbsapp');
    ctes.push(cte.sql);
    Object.assign(params, cte.params, apps.params);
    baseParts.push(
      `SELECT b.idx AS idx, COALESCE(SUM(p.active_installs), 0) AS population
       FROM lbase b
       LEFT JOIN population_daily p
         ON p.day = b.day
        ${apps.sql ? `AND ${apps.sql}` : ''}
       GROUP BY b.idx`,
    );
  }

  if (baseSplit.raw.length > 0) {
    const cte = rawInstantCte(baseSplit.raw, 'lrbase', 'lr');
    const apps = appFilter(appIds, 'i.app_id', 'lbapp');
    ctes.push(cte.sql);
    Object.assign(params, cte.params, apps.params);
    baseParts.push(
      `SELECT b.idx AS idx,
              COUNT(DISTINCT i.app_id || ' ' || i.shop_id) AS population
       FROM lrbase b
       LEFT JOIN install_intervals i
         ON i.started_at <= b.as_of
        AND (i.ended_at IS NULL OR i.ended_at > b.as_of)
        ${apps.sql ? `AND ${apps.sql}` : ''}
       GROUP BY b.idx`,
    );
  }

  /*
   * The flow half. `splitBuckets` is asked one window at a time so that a window
   * reaching outside the days the rollup has built — the opening buckets of an
   * `all_time` series can start before the first event there is — degenerates to
   * a raw range for that window alone rather than for the whole series.
   */
  const movementSplit: BucketSplit = { days: [], edges: [] };
  buckets.forEach((bucket, idx) => {
    const range = {
      idx,
      from: new Date(bucket.end.getTime() - windowDays * MS_PER_DAY),
      to: bucket.end,
    };
    const usable =
      coverage.ready &&
      dayKeyOf(range.from, timeZone) >= coverage.first &&
      dayKeyOf(range.to, timeZone) <= addDayKey(coverage.last, 1);
    const one = splitBuckets([range], timeZone, usable);
    movementSplit.days.push(...one.days);
    movementSplit.edges.push(...one.edges);
  });

  const movementCte = splitCte(movementSplit);
  const rollupApps = appIdFilter(appIds, 'r.app_id', 'lmrapp');
  const rawEventApps = appFilter(appIds, 'e.app_id', 'leapp');
  ctes.push(movementCte.sql);
  Object.assign(params, movementCte.params, rollupApps.params, rawEventApps.params);

  const idxRows = buckets.map((_, idx) => {
    params[`lx${idx}`] = idx;
    return `(@lx${idx})`;
  });

  const UNINSTALL = `('uninstalled', 'deactivated')`;
  const REINSTALL = `('reinstalled', 'reactivated')`;

  /*
   * Both halves of the flow are LEFT JOINs, and that is load-bearing rather
   * than stylistic. An inner join lets SQLite pick either side as the outer
   * loop, and with an app filter on `customer_events` it picks the event
   * ledger: one walk of every event for every app, probing the fourteen-row
   * bucket list for each. Measured at seventeen seconds against a quarter of
   * one. A LEFT JOIN fixes the bucket list as the outer table, which is the
   * order the query was written for and the one the raw form already had.
   *
   * The extra unmatched rows a LEFT JOIN produces carry NULL in `r.type` and
   * `e.type`, which both CASE expressions score as zero, so they add nothing.
   */

  const SQL = `WITH ${ctes.join(', ')},
       lidx(idx) AS (VALUES ${idxRows.join(', ')}),
       base AS (
         ${baseParts.join('\n         UNION ALL\n         ')}
       ),
       movement AS (
         SELECT idx,
                COALESCE(SUM(gone), 0) AS uninstalled,
                COALESCE(SUM(back), 0) AS reinstalled
         FROM (
           SELECT b.idx AS idx,
                  CASE WHEN r.type IN ${UNINSTALL} THEN r.event_count ELSE 0 END AS gone,
                  CASE WHEN r.type IN ${REINSTALL} THEN r.event_count ELSE 0 END AS back
           FROM rdays b
           LEFT JOIN customer_event_daily r
             ON r.day >= b.day_from AND r.day < b.day_to
            ${rollupApps.sql ? `AND ${rollupApps.sql}` : ''}
           UNION ALL
           SELECT e2.idx AS idx,
                  CASE WHEN e.type IN ${UNINSTALL} THEN 1 ELSE 0 END AS gone,
                  CASE WHEN e.type IN ${REINSTALL} THEN 1 ELSE 0 END AS back
           FROM redges e2
           LEFT JOIN customer_events e
             ON e.suppressed = 0
            AND e.type IN ('uninstalled', 'deactivated', 'reinstalled', 'reactivated')
            AND e.occurred_at >= e2.lo
            AND e.occurred_at < e2.hi
            ${rawEventApps.sql ? `AND ${rawEventApps.sql}` : ''}
         )
         GROUP BY idx
       )
       SELECT lidx.idx AS idx,
              COALESCE(base.population, 0) AS population,
              COALESCE(movement.uninstalled, 0) AS uninstalled,
              COALESCE(movement.reinstalled, 0) AS reinstalled
       FROM lidx
       LEFT JOIN base ON base.idx = lidx.idx
       LEFT JOIN movement ON movement.idx = lidx.idx
       ORDER BY lidx.idx`;
  return db.prepare(SQL).all(params) as InstallChurnPoint[];
}

/**
 * Net logo churn as a fraction. Negative when reinstalls outrun uninstalls,
 * the same way net revenue churn goes negative when expansion outruns
 * contraction. Zero base means zero rate (spec 4.7).
 */
export function installChurnRate(point: InstallChurnPoint | undefined): number {
  if (!point || point.population <= 0) return 0;
  return (point.uninstalled - point.reinstalled) / point.population;
}
