import {
  bucketsCte,
  newSubscriptionSeriesByPlan,
  stockSeriesByPlan,
  usageSeriesByPlan,
  type PlanStockPoint,
  type UsagePlanPoint,
} from '../asof.js';
import type { MetricContext } from '../context.js';
import { buildResponse, type MetricResponse, type NamedSeries } from '../response.js';
import { EARNING_TYPES } from './revenue.js';

/**
 * Plan-mix reports: the same as-of reconstruction the MRR and subscription
 * counts read, split by the plan each subscription is on.
 *
 * The plan is not a new fact the sync had to be taught. Shopify names every
 * recurring charge, `derive` already carries that name onto `subscriptions.plan_name`,
 * and the Customers page has always shown it per merchant. What was missing was
 * an aggregate: nothing summed the book by tier, so "which plan earns the money"
 * and "which plan holds the customers" were questions the store could answer and
 * the dashboard could not ask.
 *
 * Both reports here are compositions read at one instant — the end of the range
 * — for the reason the by-app report is: a stock split by category has one
 * honest reading, and laying twelve months of it across a table asks the reader
 * to find that column themselves. The time series is still returned, so the same
 * response drives a stacked view if one is ever wanted.
 */

/** What a charge that arrived without a name is called, so it is visible rather than blank. */
const UNNAMED_PLAN = 'Unnamed plan';

/**
 * Metered usage from a shop that held no live subscription when the bucket
 * closed. Its own row rather than a share of someone else's: the money is real
 * and belongs in the total, and no plan earned it.
 */
const NO_PLAN = 'Usage without a plan';

/**
 * One entity's contribution to one bucket. Both revenue components reduce to
 * this shape before they are grouped, which is what lets subscription price and
 * metered usage land on the same plan row instead of being two tables the
 * reader has to add together.
 */
interface PlanContribution {
  idx: number;
  appId: string;
  appName: string | null;
  planName: string | null;
  /** False for usage the attribution could not place on a plan. */
  attributed: boolean;
  value: number;
}

/**
 * A stable, safe series key. Plan names are free text chosen by the app —
 * "Monthly subscription", "BASIC_YEARLY", anything with a dot in it — and a key
 * travels into a chart's `dataKey`, where a dot is a path lookup rather than a
 * character. Slugging avoids that; the numeric suffix keeps two names that slug
 * alike ("A B" and "A_B") from collapsing into one row.
 */
function seriesKey(appId: string, label: string, taken: Set<string>): string {
  const slug = label.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const base = `${appId}-${slug || 'plan'}`;
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}-${n}`;
  taken.add(key);
  return key;
}

interface PlanBreakdown {
  series: NamedSeries[];
  /** One value per visible bucket: the parts of that bucket, added up. */
  values: number[];
  plans: number;
  /** True when the labels carry an app name because more than one app is in scope. */
  labelledByApp: boolean;
}

/**
 * Turns per-bucket contributions into one series per plan, ordered largest
 * first as it stands at the end of the range.
 *
 * Ranked on the *final* bucket rather than on the window's total, because that
 * is the figure the share table divides. Ranking by the sum would put a plan
 * that was retired in March above the one that replaced it.
 */
function planBreakdown(
  buckets: MetricContext['window']['buckets'],
  contributions: PlanContribution[],
  // A flow has no standing figure at the end of the range, only what arrived
  // across it, so its plans rank on the window's total instead.
  rankOn: 'final' | 'total' = 'final',
  unattributedLabel: string = NO_PLAN,
): PlanBreakdown {
  const apps = new Set(contributions.map((row) => row.appId));
  const labelledByApp = apps.size > 1;

  const keys = new Map<string, string>();
  const names = new Map<string, string>();
  const taken = new Set<string>();
  const byKeyAndIdx = new Map<string, number>();
  const lastIdx = buckets.length - 1;
  const finalValue = new Map<string, number>();

  for (const row of contributions) {
    // Unattributed usage is its own identity, and cannot collide with a real
    // charge that happened to arrive without a name.
    const identity = row.attributed ? `plan ${row.appId} ${row.planName ?? ''}` : `none ${row.appId}`;
    let key = keys.get(identity);
    if (key === undefined) {
      const plan = row.attributed ? (row.planName?.trim() ? row.planName : UNNAMED_PLAN) : unattributedLabel;
      const app = row.appName ?? `App ${row.appId}`;
      key = seriesKey(row.appId, plan, taken);
      keys.set(identity, key);
      names.set(key, labelledByApp ? `${app} · ${plan}` : plan);
    }
    const cell = `${row.idx} ${key}`;
    byKeyAndIdx.set(cell, (byKeyAndIdx.get(cell) ?? 0) + row.value);
    if (rankOn === 'total' || row.idx === lastIdx) {
      finalValue.set(key, (finalValue.get(key) ?? 0) + row.value);
    }
  }

  const dates = buckets.map((bucket) => bucket.start.toISOString());
  // Largest first, and alphabetical inside a tie. Counts tie constantly — three
  // plans holding one contract each — and leaving those to the order SQLite
  // happened to return would reshuffle the table between two reads of the same
  // book.
  const ranked = [...keys.values()].sort((a, b) => {
    const gap = (finalValue.get(b) ?? 0) - (finalValue.get(a) ?? 0);
    return gap !== 0 ? gap : names.get(a)!.localeCompare(names.get(b)!);
  });

  const series: NamedSeries[] = ranked.map((key) => ({
    key,
    name: names.get(key)!,
    data: dates.map((date, idx) => ({
      date,
      value: Math.round((byKeyAndIdx.get(`${idx} ${key}`) ?? 0) * 100) / 100,
    })),
  }));

  const values = buckets.map((_, idx) =>
    series.reduce((total, item) => total + (item.data[idx]?.value ?? 0), 0),
  );

  return { series, values, plans: ranked.length, labelledByApp };
}

const fromSubscriptions = (points: PlanStockPoint[], pick: (point: PlanStockPoint) => number) =>
  points.map(
    (point): PlanContribution => ({
      idx: point.idx,
      appId: point.appId,
      appName: point.appName,
      planName: point.planName,
      attributed: true,
      value: pick(point),
    }),
  );

const fromUsage = (points: UsagePlanPoint[]) =>
  points.map(
    (point): PlanContribution => ({
      idx: point.idx,
      appId: point.appId,
      appName: point.appName,
      planName: point.planName,
      attributed: point.hasPlan === 1,
      value: point.usage,
    }),
  );

/**
 * MRR split by the plan earning it, composed from the same components the MRR
 * card composes: subscription price, and metered usage where the reader has it
 * switched on.
 *
 * Usage belongs here even though it carries no plan of its own. Leaving it out
 * made this table quietly disagree with the MRR headline beside it by the whole
 * size of the metered book — on a business earning a fifth of its revenue that
 * way, a "contribution by plan" that omits the fifth is answering a different
 * question than the one it is titled. It is attributed by shop-and-app, the same
 * rule churn already uses; `usageSeriesByPlan` documents what that can and
 * cannot know, and usage from a shop with no live subscription is reported under
 * its own row rather than folded into a plan that did not earn it.
 */
export function mrrByPlanReport(context: MetricContext): MetricResponse {
  const buckets = context.window.buckets;
  const contributions = [
    ...fromSubscriptions(
      stockSeriesByPlan(context.db, buckets, context.asOf),
      (point) => point.mrr,
    ),
    ...(context.includeUsage
      ? fromUsage(usageSeriesByPlan(context.db, buckets, context.asOf))
      : []),
  ];
  const breakdown = planBreakdown(buckets, contributions);

  return buildResponse({
    metric: 'mrr_by_plan',
    kind: 'stock',
    format: 'money',
    window: context.window,
    values: breakdown.values,
    currency: context.currency,
    series: breakdown.series,
    meta: {
      plans: breakdown.plans,
      basis: 'MRR as of the end of the range, split by plan and ordered largest first',
      // A plan name belongs to the app that chose it, so the rows are keyed on
      // both and the labels say which app when there is more than one.
      groupedBy: breakdown.labelledByApp ? 'app and plan' : 'plan',
      includeAnnual: context.asOf.includeAnnual,
      includeTrials: context.asOf.includeTrials,
      includeUsage: context.includeUsage,
      ...(context.includeUsage
        ? {
            usageAttribution:
              'Metered usage carries no charge, so it is credited to the plan its shop was on at the end of each bucket, read as the same monthly rate the MRR card uses. Consumption by a shop with no live subscription is reported on its own row.',
          }
        : {}),
      note: 'Annual plans contribute 1/12 of their price, as everywhere else. A plan sold on both cadences appears once per charge name, which is how Shopify names them.',
    },
  });
}

/**
 * The same split, counting contracts instead of money: how many subscriptions
 * sit on each plan.
 *
 * Contracts rather than subscribers, and that is a choice worth naming. One shop
 * can hold two charges on two different plans, so counting merchants per plan
 * would produce rows that add up to more than the subscriber headline — a table
 * whose total contradicts the card above it. Counting charges keeps the parts
 * equal to the whole, which is the property this view exists to show.
 *
 * Usage does not appear, for the reason it does appear in the money view: it is
 * revenue, not a contract. A shop consuming metered capacity is already counted
 * on the plan it holds, and a row of "1" for usage would be counting the same
 * relationship twice.
 */
export function subscriptionsByPlanReport(context: MetricContext): MetricResponse {
  const buckets = context.window.buckets;
  const breakdown = planBreakdown(
    buckets,
    fromSubscriptions(
      stockSeriesByPlan(context.db, buckets, context.asOf),
      (point) => point.subscriptions,
    ),
  );

  return buildResponse({
    metric: 'subscriptions_by_plan',
    kind: 'stock',
    format: 'count',
    window: context.window,
    values: breakdown.values,
    series: breakdown.series,
    meta: {
      plans: breakdown.plans,
      basis: 'live subscriptions as of the end of the range, split by plan and ordered largest first',
      groupedBy: breakdown.labelledByApp ? 'app and plan' : 'plan',
      counts: 'subscriptions, not subscribers — one shop on two plans is counted on both',
      includeAnnual: context.asOf.includeAnnual,
      includeTrials: context.asOf.includeTrials,
    },
  });
}

/**
 * Only what arrived: subscriptions that started paying inside each bucket, split
 * by the plan they started on. The same inflow the New subscriptions card counts
 * — plan changes excluded — so each bucket's plan rows add up to that card's bar.
 *
 * Contracts, not subscribers, for the reason the stock split counts contracts:
 * the parts have to add up to the whole.
 */
export function newSubscriptionsByPlanReport(context: MetricContext): MetricResponse {
  const buckets = context.window.buckets;
  const breakdown = planBreakdown(
    buckets,
    fromSubscriptions(
      newSubscriptionSeriesByPlan(context.db, buckets, context.asOf),
      (point) => point.subscriptions,
    ),
    'total',
  );

  return buildResponse({
    metric: 'new_subscriptions_by_plan',
    kind: 'flow',
    format: 'count',
    window: context.window,
    values: breakdown.values,
    series: breakdown.series,
    meta: {
      plans: breakdown.plans,
      basis: 'subscriptions that started paying in each bucket, split by plan and ordered by the total over the range',
      groupedBy: breakdown.labelledByApp ? 'app and plan' : 'plan',
      excludes: 'plan changes (upgrade or downgrade to a new charge)',
      includeAnnual: context.asOf.includeAnnual,
      includeTrials: context.asOf.includeTrials,
    },
  });
}

/**
 * Money collected in each bucket, split by plan: the Gross earnings card, read
 * by tier. Every payment counts, from new customers and old, so each bucket's
 * plan rows add up to that card's bar.
 *
 * Read from the raw transactions rather than the daily rollup, because the
 * rollup has no plan to split on. It is a year of a few tens of thousands of
 * rows, which is not what the rollup exists to avoid.
 *
 * A subscription sale names its charge, so it lands on that charge's plan.
 * Usage, credits and one-time sales name nothing, so they are placed by
 * shop-and-app: on the plan the pair held when the money moved, or — since usage
 * is billed in arrears and often lands after a cancellation — on the last plan
 * it held before then. Money from a pair that never held one gets its own row.
 */
export function moneyByPlanReport(context: MetricContext): MetricResponse {
  const buckets = context.window.buckets;
  const cte = bucketsCte(buckets);
  const params: Record<string, unknown> = { ...cte.params };
  const types = EARNING_TYPES.map((type, index) => {
    params[`mtype${index}`] = type;
    return `@mtype${index}`;
  });
  const apps = context.appIds.map((id, index) => {
    params[`mapp${index}`] = id;
    return `@mapp${index}`;
  });
  /*
   * A payment with no charge of its own goes to the newest charge its pair had
   * started by then, preferring one still live when it paid. Written as the MAX
   * of one sort key — live flag, activation, then the id after a `|` — because
   * SQLite will not resolve an outer column in a subquery's ORDER BY.
   */
  const PICK_KEY = `(CASE WHEN s.churn_at IS NULL OR s.churn_at > p.paid_at THEN '1' ELSE '0' END
                     || s.activated_at || '|' || s.charge_id)`;
  const rows = context.db
    .prepare(
      `WITH ${cte.sql},
       payments AS (
         SELECT b.idx AS idx, t.app_id AS app_id, t.shop_id AS shop_id, t.type AS type,
                t.charge_ref AS charge_ref, t.created_at AS paid_at, t.gross_amount AS gross
         FROM buckets b
         JOIN transactions t
           ON t.created_at >= b.bucket_from
          AND t.created_at < b.as_of
          AND t.type IN (${types.join(', ')})
          ${apps.length > 0 ? `AND t.app_id IN (${apps.join(', ')})` : 'AND 0'}
       ),
       paid AS (
         SELECT p.idx AS idx,
                p.app_id AS app_id,
                p.gross AS gross,
                COALESCE(
                  CASE WHEN p.type = 'AppSubscriptionSale' THEN
                    (SELECT s.charge_id FROM subscriptions s WHERE s.charge_ref = p.charge_ref LIMIT 1)
                  END,
                  (SELECT substr(MAX(${PICK_KEY}), instr(MAX(${PICK_KEY}), '|') + 1)
                    FROM subscriptions s
                    WHERE s.app_id = p.app_id AND s.shop_id = p.shop_id AND s.is_test = 0
                      AND s.activated_at IS NOT NULL AND s.activated_at <= p.paid_at)
                ) AS charge_id
         FROM payments p
       )
       SELECT p.idx AS idx,
              p.app_id AS appId,
              (SELECT a.name FROM apps a WHERE a.id = p.app_id) AS appName,
              s.plan_name AS planName,
              p.charge_id IS NOT NULL AS hasPlan,
              COALESCE(SUM(p.gross), 0) AS value
       FROM paid p
       LEFT JOIN subscriptions s ON s.charge_id = p.charge_id
       GROUP BY p.idx, p.app_id, s.plan_name, p.charge_id IS NOT NULL
       ORDER BY p.idx`,
    )
    .all(params) as Array<{
    idx: number;
    appId: string;
    appName: string | null;
    planName: string | null;
    hasPlan: number;
    value: number;
  }>;

  const breakdown = planBreakdown(
    buckets,
    rows.map((row) => ({ ...row, attributed: row.hasPlan === 1 })),
    'total',
    'Payments without a plan',
  );

  return buildResponse({
    metric: 'money_by_plan',
    kind: 'flow',
    format: 'money',
    window: context.window,
    values: breakdown.values,
    currency: context.currency,
    series: breakdown.series,
    meta: {
      plans: breakdown.plans,
      basis: 'gross payments collected in each bucket, split by plan and ordered by the total over the range',
      groupedBy: breakdown.labelledByApp ? 'app and plan' : 'plan',
      attribution:
        'Subscription sales go to their own charge. Usage, credits and one-time sales go to the plan the shop held when the money moved, or the last one it held before then.',
      note: 'Every payment, from new and existing customers alike, before Shopify’s revenue share — the same money as Gross earnings.',
    },
  });
}

/**
 * Installs and what became of them, split by plan.
 *
 * An install carries no plan — a shop installs first and chooses later, if at
 * all — so each is placed on the first plan the shop activated *during that
 * install*, and one that never subscribed is its own row. That row is most
 * installs, and where most same-day uninstalls live; hiding it would make
 * retention look far better than it is.
 *
 * Only intervals opened by an install count. One opened by a shop reopening is
 * the same install resuming, not a new one; a reinstall after an uninstall is a
 * new install and counts again.
 */
interface InstallRow {
  idx: number;
  appId: string;
  appName: string | null;
  planName: string | null;
  hasPlan: number;
  /** Days from install to the interval closing, or NULL while still installed. */
  days: number | null;
  /** Days from install to now: how far along its curve this install can be read. */
  age: number;
}

function installRows(context: MetricContext): InstallRow[] {
  const cte = bucketsCte(context.window.buckets);
  const params: Record<string, unknown> = { ...cte.params, installNow: context.now.toISOString() };
  const apps = context.appIds.map((id, index) => {
    params[`iapp${index}`] = id;
    return `@iapp${index}`;
  });
  // The earliest charge activated while this install was open. MIN of one key
  // rather than ORDER BY, because SQLite will not resolve the outer install's
  // columns in a subquery's ORDER BY.
  const FIRST = `MIN(s.activated_at || '|' || s.charge_id)`;

  return context.db
    .prepare(
      `WITH ${cte.sql},
       installs AS (
         SELECT b.idx AS idx, i.app_id AS app_id, i.started_at AS started_at, i.ended_at AS ended_at,
                (SELECT substr(${FIRST}, instr(${FIRST}, '|') + 1)
                   FROM subscriptions s
                  WHERE s.app_id = i.app_id AND s.shop_id = i.shop_id AND s.is_test = 0
                    AND s.activated_at IS NOT NULL
                    AND s.activated_at >= i.started_at
                    AND (i.ended_at IS NULL OR s.activated_at < i.ended_at)) AS charge_id
         FROM buckets b
         JOIN install_intervals i
           ON i.started_by = 'installed'
          AND i.started_at >= b.bucket_from
          AND i.started_at < b.as_of
          ${apps.length > 0 ? `AND i.app_id IN (${apps.join(', ')})` : 'AND 0'}
       )
       SELECT n.idx AS idx,
              n.app_id AS appId,
              (SELECT a.name FROM apps a WHERE a.id = n.app_id) AS appName,
              s.plan_name AS planName,
              n.charge_id IS NOT NULL AS hasPlan,
              CASE WHEN n.ended_at IS NULL THEN NULL
                   ELSE julianday(n.ended_at) - julianday(n.started_at) END AS days,
              julianday(@installNow) - julianday(n.started_at) AS age
       FROM installs n
       LEFT JOIN subscriptions s ON s.charge_id = n.charge_id`,
    )
    .all(params) as InstallRow[];
}

const NO_PLAN_INSTALL = 'No plan';

/** Installs per bucket, split by the plan each went on to choose. */
export function installsByPlanReport(context: MetricContext): MetricResponse {
  const buckets = context.window.buckets;
  const breakdown = planBreakdown(
    buckets,
    installRows(context).map((row) => ({ ...row, attributed: row.hasPlan === 1, value: 1 })),
    'total',
    NO_PLAN_INSTALL,
  );

  return buildResponse({
    metric: 'installs_by_plan',
    kind: 'flow',
    format: 'count',
    window: context.window,
    values: breakdown.values,
    series: breakdown.series,
    meta: {
      plans: breakdown.plans,
      basis: 'installs in each bucket, split by the first plan activated during the install',
      groupedBy: breakdown.labelledByApp ? 'app and plan' : 'plan',
      excludes: 'shops reopening, which resume an install rather than start one',
    },
  });
}

/** The bands an install's lifetime falls into, in the order they are shown. */
export const RETENTION_BANDS = [
  { key: 'withinDay', label: 'Within a day' },
  { key: 'within15', label: '1–15 days' },
  { key: 'within90', label: '15–90 days' },
  { key: 'after90', label: 'After 90 days' },
  { key: 'stillInstalled', label: 'Still installed' },
] as const;

type BandKey = (typeof RETENTION_BANDS)[number]['key'];

export interface RetentionRow extends Record<BandKey, number> {
  key: string;
  name: string;
  planName: string;
  appName: string | null;
  installs: number;
}

/** How far the curves run, in days since install. */
const CURVE_DAYS = 90;
/**
 * Below this many installs still being watched, a point is still given — every
 * plan is shown — but flagged, so a view can say it rests on a handful.
 */
const CURVE_FEW_INSTALLS = 10;

export interface RetentionCurve {
  key: string;
  name: string;
  /** The two halves of `name`, so a view can set the plan above its app. */
  planName: string;
  appName: string | null;
  installs: number;
  /**
   * One point per day, as a percentage. `retained` is null once no install has
   * been around that long; `eligible` is how many it rests on.
   */
  points: Array<{ day: number; retained: number | null; eligible: number }>;
}

/**
 * The share of a plan's installs still installed N days after installing, as a
 * Kaplan–Meier estimate.
 *
 * An install still here today has been watched for only as long as it has
 * existed. Counting last week's installs as "still here at day 60" would lift
 * every curve by however much of the range is recent; dropping them instead
 * makes the curve rise wherever the mix of old and new installs shifts. The
 * estimate avoids both: each day's drop is the uninstalls that day over the
 * installs still being watched, and the curve is the running product, so it
 * only ever falls.
 */
function curveOf(rows: InstallRow[]): RetentionCurve['points'] {
  // How long each install has been watched, and whether it ended by leaving.
  const watched = rows.map((row) => ({ time: row.days ?? row.age, left: row.days !== null }));
  const points: RetentionCurve['points'] = [];
  let survival = 1;
  let open = true;
  for (let day = 0; day <= CURVE_DAYS; day += 1) {
    const atRisk = watched.filter((item) => item.time >= day).length;
    if (atRisk === 0) open = false;
    points.push({
      day,
      eligible: atRisk,
      retained: open ? Math.round(survival * 1000) / 10 : null,
    });
    const left = watched.filter((item) => item.left && item.time >= day && item.time < day + 1).length;
    if (atRisk > 0) survival *= 1 - left / atRisk;
  }
  return points;
}

function bandOf(days: number | null): BandKey {
  if (days === null) return 'stillInstalled';
  if (days < 1) return 'withinDay';
  if (days < 15) return 'within15';
  if (days < 90) return 'within90';
  return 'after90';
}

/**
 * How long the installs made in the range stayed, by plan: one row per plan,
 * the installs split into non-overlapping bands by how long they lasted.
 *
 * The bands run to "still installed" so every row adds up to its installs. An
 * install from last week cannot yet have lasted 90 days, and a table that only
 * had the three uninstall bands would leave it nowhere — reading as retained
 * when it has simply not been around long enough to leave.
 *
 * Read at today, not at the end of the range: the question is what those
 * installs went on to do, and a range ending last month still wants to know.
 */
export function uninstallsByPlanReport(context: MetricContext): MetricResponse {
  const buckets = context.window.buckets;
  const rows = installRows(context);
  const perBucket = buckets.map(() => 0);
  const byPlan = new Map<string, RetentionRow>();
  const members = new Map<string, InstallRow[]>();
  const labelledByApp = new Set(rows.map((row) => row.appId)).size > 1;

  for (const row of rows) {
    perBucket[row.idx] = (perBucket[row.idx] ?? 0) + 1;
    const identity = row.hasPlan ? `plan ${row.appId} ${row.planName ?? ''}` : `none ${row.appId}`;
    let entry = byPlan.get(identity);
    if (!entry) {
      const plan = row.hasPlan ? (row.planName?.trim() ? row.planName : UNNAMED_PLAN) : NO_PLAN_INSTALL;
      const app = row.appName ?? `App ${row.appId}`;
      entry = {
        key: identity,
        name: labelledByApp ? `${app} · ${plan}` : plan,
        planName: plan,
        appName: labelledByApp ? app : null,
        installs: 0,
        withinDay: 0,
        within15: 0,
        within90: 0,
        after90: 0,
        stillInstalled: 0,
      };
      byPlan.set(identity, entry);
    }
    entry.installs += 1;
    entry[bandOf(row.days)] += 1;
    members.set(identity, [...(members.get(identity) ?? []), row]);
  }

  const table = [...byPlan.values()].sort(
    (a, b) => b.installs - a.installs || a.name.localeCompare(b.name),
  );
  const curves: RetentionCurve[] = table.map((row) => ({
      key: row.key,
      name: row.name,
      planName: row.planName,
      appName: row.appName,
      installs: row.installs,
      points: curveOf(members.get(row.key) ?? []),
    }));
  // Every install together, as the line each plan is read against.
  const overall: RetentionCurve = {
    key: 'all',
    name: 'All installs',
    planName: 'All installs',
    appName: null,
    installs: rows.length,
    points: curveOf(rows),
  };

  return buildResponse({
    metric: 'uninstalls_by_plan',
    kind: 'flow',
    format: 'count',
    window: context.window,
    values: perBucket,
    meta: {
      rows: table,
      bands: RETENTION_BANDS,
      curves,
      overall,
      // The card's headline: of the installs made in the range, how many are
      // still installed today. The installs themselves are the context for it.
      stillInstalled: table.reduce((sum, row) => sum + row.stillInstalled, 0),
      installs: rows.length,
      fewInstalls: CURVE_FEW_INSTALLS,
      curveBasis: `Kaplan–Meier estimate of the share of installs still installed each day after installing, so recent installs count only for as long as they have existed; a point resting on fewer than ${CURVE_FEW_INSTALLS} installs is flagged by its eligible count`,
      basis: 'installs made in the range, split by plan and by how long each stayed installed, read as of today',
      bandsAre: 'non-overlapping: under 1 day, 1 to 15 days, 15 to 90 days, over 90 days, and not yet uninstalled',
      note: 'A shop closing ends an install the same way an uninstall does, and is counted as one.',
    },
  });
}
