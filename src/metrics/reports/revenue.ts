import { bucketsCte, stockSeries, stockSeriesByApp, usageSeries } from '../asof.js';
import type { MetricContext } from '../context.js';
import { growthFrom } from '../growth.js';
import { buildResponse, type MetricResponse, type NamedSeries } from '../response.js';
import type { Bucket } from '../time.js';

/**
 * Recurring revenue reports (spec 4.1-4.3).
 *
 * MRR composes three independently-reconstructed components so the dashboard
 * can show where the money comes from, and so a surprise in the total can be
 * traced to one of them.
 */

interface MrrComponents {
  /** One entry per bucket, including the hidden leading bucket at index 0. */
  monthly: number[];
  annual: number[];
  usage: number[];
  total: number[];
}

function mrrComponents(context: MetricContext, buckets: Bucket[]): MrrComponents {
  const stock = stockSeries(context.db, buckets, context.asOf);
  const byIndex = new Map(stock.map((point) => [point.idx, point]));
  const usage = context.includeUsage
    ? usageSeries(context.db, buckets, context.appIds)
    : new Map<number, number>();

  const monthly: number[] = [];
  const annual: number[] = [];
  const usageValues: number[] = [];
  const total: number[] = [];

  for (let idx = 0; idx < buckets.length; idx += 1) {
    const point = byIndex.get(idx);
    const m = point?.monthlyMrr ?? 0;
    // The as-of predicate already drops annual plans when includeAnnual is off,
    // so this column is zero in that case rather than needing a second guard.
    const a = point?.annualMrr ?? 0;
    const u = usage.get(idx) ?? 0;
    monthly.push(m);
    annual.push(a);
    usageValues.push(u);
    total.push(m + a + u);
  }

  return { monthly, annual, usage: usageValues, total };
}

/**
 * The breakdown carries only the components the reader asked for. A band that
 * is flat zero because it was filtered out is worse than no band at all: it
 * reads as "this component earned nothing" rather than "you are not looking at
 * it", and it spends a categorical colour slot saying so.
 */
function componentSeries(
  buckets: Bucket[],
  components: MrrComponents,
  includeRecurring: boolean,
  includeUsage: boolean,
): NamedSeries[] {
  const dates = buckets.map((bucket) => bucket.start.toISOString());
  const build = (key: string, name: string, values: number[]): NamedSeries => ({
    key,
    name,
    data: dates.map((date, index) => ({ date, value: Math.round((values[index] ?? 0) * 100) / 100 })),
  });

  const series: NamedSeries[] = [];
  if (includeRecurring) {
    series.push(build('monthly', 'Monthly plans', components.monthly));
    series.push(build('annual', 'Annual plans', components.annual));
  }
  if (includeUsage) series.push(build('usage', 'Usage', components.usage));
  return series;
}

export function mrrReport(context: MetricContext): MetricResponse {
  const components = mrrComponents(context, context.bucketsWithLead);
  const [leading, ...visible] = components.total;

  return buildResponse({
    metric: 'mrr',
    kind: 'stock',
    format: 'money',
    window: context.window,
    values: visible,
    leadingValue: leading ?? null,
    currency: context.currency,
    series: componentSeries(
      context.window.buckets,
      {
        monthly: components.monthly.slice(1),
        annual: components.annual.slice(1),
        usage: components.usage.slice(1),
        total: visible,
      },
      context.asOf.includeSubscriptions !== false || context.asOf.includeTrials,
      context.includeUsage,
    ),
    meta: {
      includeAnnual: context.asOf.includeAnnual,
      includeUsage: context.includeUsage,
      includeSubscriptions: context.asOf.includeSubscriptions,
      includeTrials: context.asOf.includeTrials,
    },
  });
}

/**
 * MRR growth as a percentage per bucket, and across the window as a whole.
 *
 * The headline is the period figure, not the last bucket: "MRR grew 8% over the
 * last 12 months" is the question this metric answers, and the final month's
 * rate would answer a much smaller one.
 */
export function mrrGrowthReport(context: MetricContext): MetricResponse {
  const components = mrrComponents(context, context.bucketsWithLead);
  const growth = growthFrom(components.total);

  return buildResponse({
    metric: 'mrr_growth',
    kind: 'stock',
    format: 'percent',
    window: context.window,
    values: growth.values,
    summaryOverride: growth.periodGrowth,
    meta: {
      formula: 'MRR change against the previous bucket',
      summaryBasis: 'whole window: MRR at the end against MRR at the start',
      bucketsWithoutBase: growth.undefinedBuckets,
    },
  });
}

/**
 * The palette carries four categorical slots, so at most four series can be
 * told apart by colour. Beyond that the tail folds into "Other" rather than
 * inventing a fifth hue.
 */
const MAX_APP_SERIES = 4;

/**
 * MRR split by the app earning it. The components sum to the MRR report's total
 * by construction — same predicate, one more GROUP BY column.
 */
export function mrrByAppReport(context: MetricContext): MetricResponse {
  const buckets = context.window.buckets;
  const points = stockSeriesByApp(context.db, buckets, context.asOf);

  const totalByApp = new Map<string, number>();
  const nameByApp = new Map<string, string>();
  for (const point of points) {
    totalByApp.set(point.appId, (totalByApp.get(point.appId) ?? 0) + point.mrr);
    if (point.appName) nameByApp.set(point.appId, point.appName);
  }

  /**
   * Which apps get their own slot is a size question, but their colour is not:
   * the kept ids are sorted by id so a slot belongs to an app rather than to a
   * rank, and adding a bigger app later does not repaint the others.
   */
  const ranked = [...totalByApp.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const folds = ranked.length > MAX_APP_SERIES;
  const kept = new Set(ranked.slice(0, folds ? MAX_APP_SERIES - 1 : MAX_APP_SERIES));
  const keptIds = [...kept].sort();

  const byIdxAndApp = new Map<string, number>();
  for (const point of points) {
    const app = kept.has(point.appId) ? point.appId : 'other';
    const key = `${point.idx} ${app}`;
    byIdxAndApp.set(key, (byIdxAndApp.get(key) ?? 0) + point.mrr);
  }

  const dates = buckets.map((bucket) => bucket.start.toISOString());
  const seriesFor = (key: string, name: string): NamedSeries => ({
    key,
    name,
    data: dates.map((date, idx) => ({
      date,
      value: Math.round((byIdxAndApp.get(`${idx} ${key}`) ?? 0) * 100) / 100,
    })),
  });

  const series = keptIds.map((id) => seriesFor(id, nameByApp.get(id) ?? `App ${id}`));
  if (folds) series.push(seriesFor('other', `Other (${ranked.length - kept.size} apps)`));

  const values = buckets.map((_, idx) =>
    series.reduce((total, item) => total + (item.data[idx]?.value ?? 0), 0),
  );

  return buildResponse({
    metric: 'mrr_by_app',
    kind: 'stock',
    format: 'money',
    window: context.window,
    values,
    currency: context.currency,
    series,
    meta: {
      apps: totalByApp.size,
      note: folds
        ? `Only the ${MAX_APP_SERIES - 1} largest apps get their own band; the rest are folded into "Other".`
        : undefined,
    },
  });
}

/** ARR is a pure run-rate: the current MRR annualized, with no growth model. */
export function arrReport(context: MetricContext): MetricResponse {
  const components = mrrComponents(context, context.bucketsWithLead);
  const annualized = components.total.map((value) => value * 12);
  const [leading, ...visible] = annualized;

  return buildResponse({
    metric: 'arr',
    kind: 'stock',
    format: 'money',
    window: context.window,
    values: visible,
    leadingValue: leading ?? null,
    currency: context.currency,
    meta: {
      basis: 'latest MRR x 12',
      includeAnnual: context.asOf.includeAnnual,
      includeUsage: context.includeUsage,
    },
  });
}

/** Transaction types that make up what merchants actually paid. */
const EARNING_TYPES = [
  'AppSubscriptionSale',
  'AppOneTimeSale',
  'AppUsageSale',
  'AppSaleAdjustment',
  'AppSaleCredit',
];

interface EarningsRow {
  idx: number;
  gross: number;
  net: number;
  subscription: number;
  oneTime: number;
  usage: number;
  adjustments: number;
}

/**
 * Gross earnings (spec 4.3) is a flow: what merchants paid inside each bucket,
 * summed over the range. It comes from the transactions feed rather than the
 * subscription index, because billed money and contracted price diverge
 * (proration, refunds, failed charges).
 */
export function grossEarningsReport(context: MetricContext): MetricResponse {
  const buckets = context.window.buckets;
  const cte = bucketsCte(buckets);

  const params: Record<string, unknown> = { ...cte.params };
  const appNames = context.appIds.map((id, index) => {
    params[`eapp${index}`] = id;
    return `@eapp${index}`;
  });
  const appFilter = appNames.length > 0 ? `AND t.app_id IN (${appNames.join(', ')})` : '';
  const typeNames = EARNING_TYPES.map((type, index) => {
    params[`etype${index}`] = type;
    return `@etype${index}`;
  });

  const rows = context.db
    .prepare(
      `WITH ${cte.sql}
       SELECT b.idx AS idx,
              COALESCE(SUM(t.gross_amount), 0) AS gross,
              COALESCE(SUM(t.net_amount), 0) AS net,
              COALESCE(SUM(CASE WHEN t.type = 'AppSubscriptionSale' THEN t.gross_amount ELSE 0 END), 0) AS subscription,
              COALESCE(SUM(CASE WHEN t.type = 'AppOneTimeSale' THEN t.gross_amount ELSE 0 END), 0) AS oneTime,
              COALESCE(SUM(CASE WHEN t.type = 'AppUsageSale' THEN t.gross_amount ELSE 0 END), 0) AS usage,
              COALESCE(SUM(CASE WHEN t.type IN ('AppSaleAdjustment', 'AppSaleCredit') THEN t.gross_amount ELSE 0 END), 0) AS adjustments
       FROM buckets b
       LEFT JOIN transactions t
         ON t.created_at >= b.bucket_from
        AND t.created_at < b.as_of
        AND t.type IN (${typeNames.join(', ')})
        ${appFilter}
       GROUP BY b.idx
       ORDER BY b.idx`,
    )
    .all(params) as EarningsRow[];

  const byIndex = new Map(rows.map((row) => [row.idx, row]));
  const values = buckets.map((_, idx) => byIndex.get(idx)?.gross ?? 0);
  const dates = buckets.map((bucket) => bucket.start.toISOString());

  const series: NamedSeries[] = (
    [
      ['subscription', 'Subscriptions', (row: EarningsRow) => row.subscription],
      ['oneTime', 'One-time charges', (row: EarningsRow) => row.oneTime],
      ['usage', 'Usage charges', (row: EarningsRow) => row.usage],
      ['adjustments', 'Refunds & credits', (row: EarningsRow) => row.adjustments],
    ] as const
  ).map(([key, name, pick]) => ({
    key,
    name,
    data: dates.map((date, idx) => {
      const row = byIndex.get(idx);
      return { date, value: row ? Math.round(pick(row) * 100) / 100 : 0 };
    }),
  }));

  const netTotal = buckets.reduce((total, _, idx) => total + (byIndex.get(idx)?.net ?? 0), 0);

  return buildResponse({
    metric: 'gross_earnings',
    kind: 'flow',
    format: 'money',
    window: context.window,
    values,
    currency: context.currency,
    series,
    meta: {
      // Net is what actually reaches the payout after Shopify's revenue share;
      // carried in meta so the headline stays unambiguously gross.
      netEarnings: Math.round(netTotal * 100) / 100,
    },
  });
}
