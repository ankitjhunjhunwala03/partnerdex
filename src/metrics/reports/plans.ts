import {
  stockSeriesByPlan,
  usageSeriesByPlan,
  type PlanStockPoint,
  type UsagePlanPoint,
} from '../asof.js';
import type { MetricContext } from '../context.js';
import { buildResponse, type MetricResponse, type NamedSeries } from '../response.js';

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
      const plan = row.attributed ? (row.planName?.trim() ? row.planName : UNNAMED_PLAN) : NO_PLAN;
      const app = row.appName ?? `App ${row.appId}`;
      key = seriesKey(row.appId, plan, taken);
      keys.set(identity, key);
      names.set(key, labelledByApp ? `${app} · ${plan}` : plan);
    }
    const cell = `${row.idx} ${key}`;
    byKeyAndIdx.set(cell, (byKeyAndIdx.get(cell) ?? 0) + row.value);
    if (row.idx === lastIdx) finalValue.set(key, (finalValue.get(key) ?? 0) + row.value);
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
              'Metered usage carries no charge, so it is credited to the plan its shop was on at the end of each bucket, read as a trailing-30-day rate. Consumption by a shop with no live subscription is reported on its own row.',
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
