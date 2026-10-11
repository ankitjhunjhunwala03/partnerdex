import type { Db } from '../db/index.js';
import {
  appFilter,
  asOfPredicate,
  componentClauses,
  COUNT_PRICED_SUBSCRIBERS,
  COUNT_SUBSCRIBERS,
  COUNT_PRICED_SUBSCRIPTIONS,
  gateColumn,
  PRICED,
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
import { PLAN_CHANGE_WINDOW_SECONDS } from '../sync/planChange.js';
import type { UsageKind } from '../usage/recognition.js';

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
 * Which recognized usage rows a view counts, by the components it has on.
 *
 * A plan's fee billed through usage is the plan's price, so it rides with the
 * subscription component — and an annual one with the annual filter too, as an
 * annual price does. Only metered spend is usage in the business sense, and only
 * it answers to the Usage filter. See `UsageKind` for what each kind is.
 */
export function usageKinds(options: AsOfOptions): UsageKind[] {
  const kinds: UsageKind[] = [];
  if (options.includeSubscriptions !== false) {
    kinds.push('fee');
    if (options.includeAnnual) kinds.push('annual');
  }
  if (options.includeUsage) kinds.push('metered');
  return kinds;
}

/** True for a kind that is a plan's own price rather than consumption. */
const FEE_KIND = `u.kind <> 'metered'`;

/**
 * The recognized usage rows of the given kinds and apps, as a
 * `usage_recognized` CTE. Worked out once per sync and per settings change, not
 * per query — see `usage/recognition.ts`, which is where what they mean is
 * explained. No kinds means no rows, which is what a view with neither
 * subscriptions nor usage switched on should read.
 */
function usageRecognized(kinds: UsageKind[], appIds: string[], prefix: string): Fragment {
  const apps = appFilter(appIds, 'r.app_id', prefix);
  const params: Record<string, unknown> = { ...apps.params };
  const names = kinds.map((kind, index) => {
    params[`${prefix}k${index}`] = kind;
    return `@${prefix}k${index}`;
  });
  const clauses = [names.length > 0 ? `r.kind IN (${names.join(', ')})` : '0 = 1'];
  if (apps.sql) clauses.push(apps.sql);
  return {
    sql: `usage_recognized AS (
         SELECT r.app_id, r.shop_id, r.created_at, r.monthly_amount, r.through, r.kind
         FROM usage_recognized_rows r
         WHERE ${clauses.join(' AND ')}
       )`,
    params,
  };
}

/** "This payment is still being recognized as of <instant>". */
const LIVE_USAGE = (instant: string) => `u.created_at <= ${instant} AND u.through > ${instant}`;

export interface StockPoint {
  idx: number;
  asOf: string;
  /** Subscription prices only; usage of every kind is composed on top. */
  monthlyMrr: number;
  annualMrr: number;
  /** Paying subscriptions: priced ones, and the shops paying through usage. */
  subscriptions: number;
  /** Paying shop-and-app pairs, the same way. */
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
              ${COUNT_PRICED_SUBSCRIPTIONS} AS subscriptions,
              ${COUNT_PRICED_SUBSCRIBERS} AS subscribers
       FROM rbuckets b
       LEFT JOIN subscriptions s
         ON ${predicate.sql}
       GROUP BY b.idx, b.as_of`,
    );
  }

  if (parts.length === 0) return [];
  const points = db.prepare(unionParts(parts, ctes)).all(params) as StockPoint[];
  // Both halves count priced subscriptions; the shops paying through usage are
  // the same at either kind of instant, so they are added once, here.
  const payers = usagePayers(db, buckets, options);
  return points.map((point) => {
    const extra = payers.get(point.idx) ?? 0;
    return { ...point, subscriptions: point.subscriptions + extra, subscribers: point.subscribers + extra };
  });
}

/**
 * The shops paying through usage alone at each bucket's end: a pair whose
 * recognized usage of the counted kinds is positive at that instant, and which
 * holds no priced subscription the view counts — those are already in the
 * priced count, and one relationship is one subscriber.
 *
 * This is the whole of how a zero-priced plan enters the counts. A shop on one
 * is paying when it is billed — its fee, or metered spend when usage is on — and
 * not before, so a free plan, or a fee plan whose first fee has not landed, is
 * not a paying customer. Counted as one subscription per pair: Shopify lets a
 * shop hold one live charge per app, and a usage row carries no charge to count
 * anyway.
 */
function usagePayers(db: Db, buckets: Bucket[], options: AsOfOptions): Map<number, number> {
  const kinds = usageKinds(options);
  if (kinds.length === 0) return new Map();
  const cte = bucketsCte(buckets);
  const usage = usageRecognized(kinds, options.appIds, 'upyapp');
  const priced = asOfPredicate(options, 'p.as_of');

  const rows = db
    .prepare(
      `WITH ${cte.sql},
       ${usage.sql},
       pairs AS (
         SELECT b.idx AS idx, b.as_of AS as_of, u.app_id AS app_id, u.shop_id AS shop_id
         FROM buckets b
         JOIN usage_recognized u ON ${LIVE_USAGE('b.as_of')}
         GROUP BY b.idx, b.as_of, u.app_id, u.shop_id
         HAVING SUM(u.monthly_amount) > ${PAYING_EPSILON}
       )
       SELECT p.idx AS idx, COUNT(*) AS value
       FROM pairs p
       WHERE NOT EXISTS (
         SELECT 1 FROM subscriptions s
          WHERE s.app_id = p.app_id AND s.shop_id = p.shop_id AND ${PRICED}
            AND ${priced.sql}
       )
       GROUP BY p.idx`,
    )
    .all({ ...cte.params, ...usage.params, ...priced.params }) as Array<{ idx: number; value: number }>;
  return new Map(rows.map((row) => [row.idx, row.value]));
}

/**
 * Below this a pair's usage is paying nothing: a charge and the credit that
 * gave it back sum to a rounding error, not to a customer.
 */
const PAYING_EPSILON = 0.005;

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
 * The same recognized usage rate as `usageSeries`, split by the app that
 * earned it. No attribution guesswork here, unlike the per-plan split: a usage
 * sale names its app outright.
 */
export function usageSeriesByApp(
  db: Db,
  buckets: Bucket[],
  options: AsOfOptions,
): Array<{ idx: number; appId: string; appName: string | null; usage: number }> {
  const cte = bucketsCte(buckets);
  const usage = usageRecognized(usageKinds(options), options.appIds, 'uaapp');

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

/** One pair's revenue at the two ends of one bucket, and what it was doing. */
export interface PairMovement {
  idx: number;
  appId: string;
  shopId: string;
  /** Subscription price plus plan fees billed through usage, at the start and end. */
  plan0: number;
  plan1: number;
  /** Metered usage at the start and end. */
  metered0: number;
  metered1: number;
  /** The pair held a frozen subscription at the start / end. */
  frozen0: number;
  frozen1: number;
  /** The pair held a live, unfrozen subscription — paying or not — at the start / end. */
  subscribed0: number;
  subscribed1: number;
  /** The pair had paid something the view counts before the bucket opened. */
  paidBefore: number;
}

/**
 * Every shop-and-app pair whose MRR changed inside each bucket, with the MRR it
 * had at each end, split into its plan part and its metered part.
 *
 * Read from exactly the sources the MRR card composes — the as-of predicate for
 * subscription prices, the recognized usage rows of the kinds the view counts
 * for the rest — at the bucket's two edges, so the changes summed over every
 * pair are the change in the MRR card across the bucket, by construction. What
 * a change *means* — a new customer, a return, a plan change, consumption
 * moving, a freeze, a loss — is decided per pair from the flags beside it, in
 * `mrrMovementReport`.
 *
 * Each distinct instant is read once: a bucket's end is the next bucket's
 * start, so a series of n buckets reads n + 1 instants rather than 2n.
 */
export function pairMovementSeries(db: Db, buckets: Bucket[], options: AsOfOptions): PairMovement[] {
  if (buckets.length === 0) return [];
  const params: Record<string, unknown> = {};
  const instantIndex = new Map<string, number>();
  const instantOf = (date: Date): number => {
    const iso = date.toISOString();
    let k = instantIndex.get(iso);
    if (k === undefined) {
      k = instantIndex.size;
      instantIndex.set(iso, k);
      params[`pmk${k}`] = k;
      params[`pma${k}`] = iso;
    }
    return k;
  };
  const spans = buckets.map((bucket, idx) => {
    const k0 = instantOf(bucket.start);
    const k1 = instantOf(bucket.end);
    params[`pmi${idx}`] = idx;
    params[`pmf${idx}`] = k0;
    params[`pmt${idx}`] = k1;
    params[`pmb${idx}`] = bucket.start.toISOString();
    params[`pme${idx}`] = bucket.end.toISOString();
    return `(@pmi${idx}, @pmf${idx}, @pmt${idx}, @pmb${idx}, @pme${idx})`;
  });
  const instants = [...instantIndex.values()].map((k) => `(@pmk${k}, @pma${k})`);

  const kinds = usageKinds(options);
  const usage = usageRecognized(kinds, options.appIds, 'pmapp');
  const predicate = asOfPredicate(options, 'i.at');
  const gate = gateColumn(options.includeTrials);
  // Whether a priced subscription before the bucket counts as having paid: only
  // when the view counts subscription prices at all. "Usage only" asks about
  // usage revenue, and a shop's first metered bill is new to it.
  const pricedCounts = options.includeSubscriptions !== false || options.includeTrials;

  const pair = (alias: string) =>
    `${alias}.app_id = m.app_id AND ${alias}.shop_id = m.shop_id AND ${alias}.is_test = 0`;
  // Held at <instant>: activated before it and not cancelled by it, the
  // predicate's own half-open reading of an instant.
  const held = (alias: string, instant: string) =>
    `${alias}.activated_at IS NOT NULL AND ${alias}.activated_at < ${instant}
            AND (${alias}.churn_at IS NULL OR ${alias}.churn_at >= ${instant})`;
  const frozenAt = (alias: string, instant: string) =>
    `(${alias}.frozen_at IS NOT NULL AND ${alias}.frozen_at < ${instant}
            AND (${alias}.unfrozen_at IS NULL OR ${alias}.unfrozen_at <= ${alias}.frozen_at
                 OR ${alias}.unfrozen_at >= ${instant}))`;

  const rows = db
    .prepare(
      `WITH instants(k, at) AS (VALUES ${instants.join(', ')}),
       spans(idx, k0, k1, from_at, to_at) AS (VALUES ${spans.join(', ')}),
       ${usage.sql},
       levels AS MATERIALIZED (
         SELECT k, app_id, shop_id, SUM(plan) AS plan, SUM(metered) AS metered
         FROM (
           SELECT i.k AS k, s.app_id AS app_id, s.shop_id AS shop_id,
                  s.monthly_amount AS plan, 0 AS metered
           FROM instants i
           JOIN subscriptions s ON ${predicate.sql}
           UNION ALL
           SELECT i.k, u.app_id, u.shop_id,
                  CASE WHEN ${FEE_KIND} THEN u.monthly_amount ELSE 0 END,
                  CASE WHEN u.kind = 'metered' THEN u.monthly_amount ELSE 0 END
           FROM instants i
           JOIN usage_recognized u ON ${LIVE_USAGE('i.at')}
         )
         GROUP BY k, app_id, shop_id
       ),
       moves AS (
         SELECT idx, app_id, shop_id,
                SUM(plan0) AS plan0, SUM(metered0) AS metered0,
                SUM(plan1) AS plan1, SUM(metered1) AS metered1
         FROM (
           SELECT sp.idx AS idx, l.app_id AS app_id, l.shop_id AS shop_id,
                  l.plan AS plan0, l.metered AS metered0, 0 AS plan1, 0 AS metered1
           FROM spans sp JOIN levels l ON l.k = sp.k0
           UNION ALL
           SELECT sp.idx, l.app_id, l.shop_id, 0, 0, l.plan, l.metered
           FROM spans sp JOIN levels l ON l.k = sp.k1
         )
         GROUP BY idx, app_id, shop_id
         HAVING ABS(SUM(plan1) - SUM(plan0)) > 1e-9 OR ABS(SUM(metered1) - SUM(metered0)) > 1e-9
       )
       SELECT m.idx AS idx, m.app_id AS appId, m.shop_id AS shopId,
              m.plan0 AS plan0, m.plan1 AS plan1, m.metered0 AS metered0, m.metered1 AS metered1,
              EXISTS (SELECT 1 FROM subscriptions s WHERE ${pair('s')}
                        AND ${held('s', 'sp.from_at')} AND ${frozenAt('s', 'sp.from_at')}) AS frozen0,
              EXISTS (SELECT 1 FROM subscriptions s WHERE ${pair('s')}
                        AND ${held('s', 'sp.to_at')} AND ${frozenAt('s', 'sp.to_at')}) AS frozen1,
              EXISTS (SELECT 1 FROM subscriptions s WHERE ${pair('s')}
                        AND ${held('s', 'sp.from_at')} AND NOT ${frozenAt('s', 'sp.from_at')}) AS subscribed0,
              EXISTS (SELECT 1 FROM subscriptions s WHERE ${pair('s')}
                        AND ${held('s', 'sp.to_at')} AND NOT ${frozenAt('s', 'sp.to_at')}) AS subscribed1,
              (${pricedCounts
                ? `EXISTS (SELECT 1 FROM subscriptions s WHERE ${pair('s')} AND ${PRICED}
                            ${options.includeAnnual ? '' : `AND s.billing_interval <> 'ANNUAL'`}
                            AND ${gate} IS NOT NULL AND ${gate} < sp.from_at) OR `
                : ''}
               EXISTS (SELECT 1 FROM usage_recognized u
                        WHERE u.app_id = m.app_id AND u.shop_id = m.shop_id
                          AND u.monthly_amount > 0 AND u.created_at < sp.from_at)) AS paidBefore
       FROM moves m
       JOIN spans sp ON sp.idx = m.idx
       ORDER BY m.idx`,
    )
    .all({ ...params, ...usage.params, ...predicate.params }) as PairMovement[];
  return rows;
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
  const usage = usageRecognized(usageKinds(options), options.appIds, 'spapp');

  // A contract is counted when it pays: by its own price, or — on a zero-priced
  // plan — by its shop being billed through usage at that instant, the same
  // rule the subscriber count applies (see `usagePayers`).
  return db
    .prepare(
      `WITH ${cte.sql},
       ${usage.sql}
       SELECT b.idx AS idx,
              s.app_id AS appId,
              a.name AS appName,
              s.plan_name AS planName,
              COALESCE(SUM(s.monthly_amount), 0) AS mrr,
              COALESCE(SUM(CASE WHEN ${PRICED} OR COALESCE((
                SELECT SUM(u.monthly_amount) FROM usage_recognized u
                 WHERE u.app_id = s.app_id AND u.shop_id = s.shop_id
                   AND ${LIVE_USAGE('b.as_of')}), 0) > ${PAYING_EPSILON}
                THEN 1 ELSE 0 END), 0) AS subscriptions
       FROM buckets b
       JOIN subscriptions s
         ON ${predicate.sql}
       LEFT JOIN apps a ON a.id = s.app_id
       GROUP BY b.idx, s.app_id, a.name, s.plan_name
       ORDER BY b.idx`,
    )
    .all({ ...cte.params, ...usage.params, ...predicate.params }) as PlanStockPoint[];
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
 * Revenue billed through usage — plan fees and metered spend, whichever kinds
 * the view counts — split by the plan the paying shop was on.
 *
 * Usage carries no charge of its own — the Partner API stamps an
 * `AppUsageRecord` id on the sale, never the subscription it belongs to — so
 * there is nothing to join a plan onto directly. It is attributed by
 * shop-and-app instead, exactly as `usageChurnCtes` attributes it: the plan is
 * whichever subscription that pair had live at the bucket's end.
 *
 * Read as the same recognized rate as `usageSeries`, so a per-plan
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
 *     rather than credited to the plan they used to hold. Recognition already
 *     ends when the subscription does, so this is the rare pair with no
 *     subscription history at all.
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
  const usage = usageRecognized(usageKinds(options), options.appIds, 'upapp');
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
 * A zero-priced plan starts paying when its shop is first billed through usage
 * during it — its first fee, or its first metered charge when usage is counted
 * — not when it is approved. Approval alone is a free plan, or a fee plan that
 * has not billed yet, and neither is a paying subscription (see `PRICED`).
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
  const rows = newSubscriptionRows(
    db,
    buckets,
    options,
    `${byShop ? COUNT_SUBSCRIBERS : 'COUNT(s.charge_id)'} AS value`,
    'b.idx',
  ) as Array<{ idx: number; value: number }>;

  return new Map(rows.map((row) => [row.idx, row.value]));
}

/**
 * The same new subscriptions, split by the plan each one started on, with the
 * monthly price it brought. Grouped from the one query `newSubscriptionSeries`
 * runs, so the plan rows of a bucket always add up to its new-subscription count.
 */
export function newSubscriptionSeriesByPlan(
  db: Db,
  buckets: Bucket[],
  options: AsOfOptions,
): PlanStockPoint[] {
  return newSubscriptionRows(
    db,
    buckets,
    options,
    `s.app_id AS appId,
            (SELECT a.name FROM apps a WHERE a.id = s.app_id) AS appName,
            s.plan_name AS planName,
            COALESCE(SUM(s.monthly_amount), 0) AS mrr,
            COUNT(s.charge_id) AS subscriptions`,
    'b.idx, s.app_id, s.plan_name',
    // Buckets with nothing new would otherwise produce a row with no plan.
    's.charge_id IS NOT NULL',
  ) as PlanStockPoint[];
}

function newSubscriptionRows(
  db: Db,
  buckets: Bucket[],
  options: AsOfOptions,
  select: string,
  groupBy: string,
  where?: string,
): unknown[] {
  const cte = bucketsCte(buckets);
  const apps = appFilter(options.appIds, 's.app_id', 'napp');
  const usage = usageRecognized(usageKinds(options), options.appIds, 'nuapp');
  const gate = gateColumn(options.includeTrials);
  // The same component gate the stock series uses, read at the bucket's end: a
  // subscription is new in the bucket its gate instant falls in, and a
  // trials-only view counts the ones that had not converted by the time the
  // bucket closed.
  const components = componentClauses(options, 'b.as_of').map((clause) => `AND ${clause}`);

  return db
    .prepare(
      `WITH ${cte.sql},
       ${usage.sql},
       -- Materialized: each subscription's start is worked out once, not once
       -- per bucket it is compared against.
       starts AS MATERIALIZED (
         SELECT s.*,
                CASE WHEN ${PRICED} THEN ${gate}
                     -- A charge raised at approval can be stamped a moment
                     -- before it, which is the gap recognition allows too.
                     ELSE (SELECT MIN(u.created_at) FROM usage_recognized u
                            WHERE u.app_id = s.app_id AND u.shop_id = s.shop_id
                              AND u.monthly_amount > 0
                              AND u.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', s.activated_at, '-' || @planChangeSeconds || ' seconds')
                              AND (s.churn_at IS NULL OR u.created_at < s.churn_at))
                END AS started_at
         FROM subscriptions s
         WHERE s.is_test = 0
           ${apps.sql ? `AND ${apps.sql}` : ''}
           ${options.includeAnnual ? '' : `AND s.billing_interval <> 'ANNUAL'`}
           AND ${gate} IS NOT NULL
       )
       SELECT b.idx AS idx, ${select}
       FROM buckets b
       LEFT JOIN starts s
         ON s.started_at IS NOT NULL
        AND s.started_at >= b.bucket_from
        AND s.started_at < b.as_of
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
       ${where ? `WHERE ${where}` : ''}
       GROUP BY ${groupBy}
       ORDER BY b.idx`,
    )
    .all({
      ...cte.params,
      ...apps.params,
      ...usage.params,
      planChangeSeconds: PLAN_CHANGE_WINDOW_SECONDS,
    });
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

export interface UsagePoint {
  /** Plan fees billed through usage: subscription revenue. */
  fees: number;
  /** Metered spend on top of a price: usage revenue. */
  metered: number;
}

/**
 * Revenue billed through usage charges, as the monthly rate being recognized at
 * each bucket's end (see `usage/recognition.ts`), split by what it paid for.
 *
 * Usage is billed in arrears and lumpy, so a single instant of *billing* says
 * nothing; what is read at the instant is the rate each payment is recognized
 * at across the term it bought. That is also why this is not served from the
 * daily money rollup: recognizing a payment across its term needs the payment's
 * own term, which the rollup's daily totals do not keep.
 *
 * The split is the point. A fee is a plan's price that happens to be billed as
 * usage, and belongs beside the subscription prices; metered spend is the only
 * part that moves with consumption. Each half is present only when the view
 * counts it (see `usageKinds`).
 */
export function usageSeries(db: Db, buckets: Bucket[], options: AsOfOptions): Map<number, UsagePoint> {
  const kinds = usageKinds(options);
  if (kinds.length === 0) return new Map();
  const cte = bucketsCte(buckets);
  const usage = usageRecognized(kinds, options.appIds, 'uapp');

  const rows = db
    .prepare(
      `WITH ${cte.sql},
       ${usage.sql}
       SELECT b.idx AS idx,
              COALESCE(SUM(CASE WHEN ${FEE_KIND} THEN u.monthly_amount ELSE 0 END), 0) AS fees,
              COALESCE(SUM(CASE WHEN u.kind = 'metered' THEN u.monthly_amount ELSE 0 END), 0) AS metered
       FROM buckets b
       LEFT JOIN usage_recognized u
         ON ${LIVE_USAGE('b.as_of')}
       GROUP BY b.idx
       ORDER BY b.idx`,
    )
    .all({ ...cte.params, ...usage.params }) as Array<{ idx: number } & UsagePoint>;

  return new Map(rows.map((row) => [row.idx, { fees: row.fees, metered: row.metered }]));
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
 * Revenue billed through usage — plan fees, and metered spend when usage is on
 * — on both sides of the churn ratio.
 *
 * Usage carries no subscription of its own — the Partner API stamps an
 * `AppUsageRecord` id on the sale, not the charge it belongs to — so it cannot
 * be gated by the as-of predicate. It is attributed by shop-and-app instead,
 * and the loss event is the one thing that is unambiguous: the pair had a live
 * subscription when the window opened and has none by the time it closes.
 *
 * On a zero-priced plan this is the *only* thing that pays, so it is what makes
 * the shop a member of the base at all: a fee plan cancelling is a customer
 * lost, and a free plan cancelling is not.
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
 *   - Counts always dedupe. A pair already inside the recurring population —
 *     paying a price the view counts — is one relationship, not two, so it only
 *     adds a head when it pays through usage alone: a fee plan, or a priced plan
 *     the component filter has left out, which is what makes "usage only"
 *     report a population instead of a zero. And only while its usage is
 *     actually paying something, the same rule `usagePayers` applies.
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
  const kinds = usageKinds(options);
  if (kinds.length === 0) return none;

  const recognized = usageRecognized(kinds, options.appIds, 'cuapp');
  // The component-filtered priced population, to dedupe counts against.
  const counted = asOfPredicate(options, 'u.window_start');
  // Any relationship at all — trials, any cadence, frozen or not — which is
  // what decides whether the pair is still a customer. Deliberately not the
  // filtered predicate: under "usage only" that one matches nothing, and every
  // pair would read as churned. And a freeze is not a loss, here as in the
  // recurring half, which only counts a cancellation.
  const held = (expr: string): Fragment => ({
    sql: `s.is_test = 0 AND s.activated_at IS NOT NULL AND s.activated_at < ${expr}
                AND (s.churn_at IS NULL OR s.churn_at >= ${expr})`,
    params: {},
  });
  const stillLive = held('u.as_of');
  const wasLive = held('u.window_start');

  const pairOf = (predicateSql: string) =>
    `SELECT 1 FROM subscriptions s
              WHERE s.app_id = u.app_id AND s.shop_id = u.shop_id AND ${predicateSql}`;
  /**
   * A head the recurring base has not already counted, and only for a pair that
   * was still a customer when the window opened — the same rule the recurring
   * base follows, because what cannot churn cannot sit in the denominator.
   * Without the second half a shop that left last month lingers here until its
   * usage ages out of its recognition term, understating churn for a month.
   */
  const countable = `CASE WHEN u.amount > ${PAYING_EPSILON}
                           AND NOT EXISTS (${pairOf(`${PRICED} AND ${counted.sql}`)})
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
    // Unread: usage is taken at `window_start` through its recognition terms
    // (see `usageRecognized`), not through a window of its own.
    params[`cu${idx}`] = new Date(windowStart.getTime() - 30 * MS_PER_DAY).toISOString();
    return `(@ci${idx}, @ca${idx}, @cw${idx}, @cu${idx})`;
  });

  const predicate = asOfPredicate(options, 'b.window_start');
  // Priced subscriptions only; the shops paying through usage join through
  // `usageChurnCtes`, exactly as they join the live counts.
  const countExpr = byShop ? COUNT_PRICED_SUBSCRIBERS : COUNT_PRICED_SUBSCRIPTIONS;
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
