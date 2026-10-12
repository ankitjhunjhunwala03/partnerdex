import {
  pairMovementSeries,
  stockSeries,
  stockSeriesByApp,
  usageSeries,
  usageSeriesByApp,
  type PairMovement,
  type StockPoint,
} from '../asof.js';
import type { MetricContext } from '../context.js';
import { appIdFilter, rollupReady, splitBuckets, splitCte } from '../rollup.js';
import { growthFrom } from '../growth.js';
import { buildResponse, type MetricResponse, type NamedSeries } from '../response.js';
import type { Bucket } from '../time.js';

/**
 * Recurring revenue reports (spec 4.1-4.3).
 *
 * MRR composes four independently-reconstructed components so the dashboard
 * can show where the money comes from, and so a surprise in the total can be
 * traced to one of them:
 *
 *   - **monthly** and **annual** plans: subscription prices, annual ones at a
 *     twelfth;
 *   - **plan fees billed as usage**: the price of a zero-priced plan, which
 *     Shopify bills through usage charges. Subscription revenue in all but the
 *     billing mechanism, so it counts wherever subscriptions do;
 *   - **metered usage**: consumption on top of a price, recognized as a monthly
 *     rate across the term each payment covers.
 *
 * The last two used to be one "Usage" band. On an app that moved its plans onto
 * usage-billed fees, that band held most of the subscription book, and a reader
 * could not tell a new customer's fee from a heavy shop's busy month.
 */

export interface MrrComponents {
  /** One entry per bucket, including the hidden leading bucket at index 0. */
  monthly: number[];
  annual: number[];
  fees: number[];
  metered: number[];
  total: number[];
  /** The subscription stock the prices came from, for readers that also need its counts. */
  stock: StockPoint[];
}

/** The MRR card's composition, shared by every report that divides or annualizes it. */
export function mrrComponents(context: MetricContext, buckets: Bucket[]): MrrComponents {
  const stock = stockSeries(context.db, buckets, context.asOf, context.window.timeZone);
  const byIndex = new Map(stock.map((point) => [point.idx, point]));
  const usage = usageSeries(context.db, buckets, context.asOf);

  const components: MrrComponents = { monthly: [], annual: [], fees: [], metered: [], total: [], stock };
  for (let idx = 0; idx < buckets.length; idx += 1) {
    const point = byIndex.get(idx);
    const m = point?.monthlyMrr ?? 0;
    // The as-of predicate already drops annual plans when includeAnnual is off,
    // so this column is zero in that case rather than needing a second guard.
    const a = point?.annualMrr ?? 0;
    const f = usage.get(idx)?.fees ?? 0;
    const u = usage.get(idx)?.metered ?? 0;
    components.monthly.push(m);
    components.annual.push(a);
    components.fees.push(f);
    components.metered.push(u);
    components.total.push(m + a + f + u);
  }
  return components;
}

/**
 * The breakdown carries only the components the reader asked for. A band that
 * is flat zero because it was filtered out is worse than no band at all: it
 * reads as "this component earned nothing" rather than "you are not looking at
 * it", and it spends a categorical colour slot saying so.
 *
 * Plan fees are the one band shown only when there are some. Most apps price
 * their plans directly and will never bill a fee through usage, and a zero band
 * on every one of their charts would be asking them to wonder why.
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
  if (components.fees.some((value) => Math.abs(value) >= 0.005)) {
    series.push(build('fees', 'Plan fees billed as usage', components.fees));
  }
  if (includeUsage) series.push(build('metered', 'Metered usage', components.metered));
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
        fees: components.fees.slice(1),
        metered: components.metered.slice(1),
        total: visible,
        stock: components.stock,
      },
      context.asOf.includeSubscriptions !== false || context.asOf.includeTrials,
      context.includeUsage,
    ),
    meta: {
      includeAnnual: context.asOf.includeAnnual,
      includeUsage: context.includeUsage,
      includeSubscriptions: context.asOf.includeSubscriptions,
      includeTrials: context.asOf.includeTrials,
      usageRecognition:
        'Plan fees billed as usage count in full for the cycle they pay for, and with subscriptions. Metered usage counts at half of each bill for 60 days, so a shop billed every few weeks reads as a steady monthly rate. Both stop when the shop cancels, freezes or uninstalls; a final bill settled after that is revenue, not MRR.',
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
 * MRR split by the app earning it. The components sum to the MRR report's total
 * by construction — same predicate, one more GROUP BY column.
 *
 * Every app gets its own row. This used to fold the tail past the fourth into
 * an "Other" band, because the palette carries four categorical slots and a
 * fifth hue would not have been distinguishable from the others. The dashboard
 * reads this as a table now, where a row is identified by its name rather than
 * its colour, so the cap has nothing left to protect — and folding the tail
 * would have hidden exactly the figure the table exists to show.
 *
 * Ordered largest first. The old order was by app id, which kept a colour
 * attached to an app as the ranking moved underneath it; a table has no colours
 * to keep stable, and size is the order a reader wants to scan.
 *
 * Composed from the same components the MRR card is: plan fees billed as usage
 * wherever subscriptions count, metered usage where the reader has it on. A
 * split that quietly left usage out totalled to less than the headline directly
 * above it — on a metered app, by the size of the whole metered book.
 */
export function mrrByAppReport(context: MetricContext): MetricResponse {
  const buckets = context.window.buckets;
  const points = stockSeriesByApp(context.db, buckets, context.asOf, context.window.timeZone);
  const usage = usageSeriesByApp(context.db, buckets, context.asOf);
  const contributions = [
    ...points.map((point) => ({ ...point, value: point.mrr })),
    ...usage.map((point) => ({ ...point, value: point.usage })),
  ];

  const totalByApp = new Map<string, number>();
  const nameByApp = new Map<string, string>();
  for (const point of contributions) {
    totalByApp.set(point.appId, (totalByApp.get(point.appId) ?? 0) + point.value);
    if (point.appName) nameByApp.set(point.appId, point.appName);
  }

  const ranked = [...totalByApp.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);

  const byIdxAndApp = new Map<string, number>();
  for (const point of contributions) {
    const key = `${point.idx} ${point.appId}`;
    byIdxAndApp.set(key, (byIdxAndApp.get(key) ?? 0) + point.value);
  }

  const dates = buckets.map((bucket) => bucket.start.toISOString());
  const series: NamedSeries[] = ranked.map((id) => ({
    key: id,
    name: nameByApp.get(id) ?? `App ${id}`,
    data: dates.map((date, idx) => ({
      date,
      value: Math.round((byIdxAndApp.get(`${idx} ${id}`) ?? 0) * 100) / 100,
    })),
  }));

  // Rounded once from the unrounded parts, so it equals the MRR card to the cent.
  const values = buckets.map(
    (_, idx) =>
      Math.round(ranked.reduce((total, id) => total + (byIdxAndApp.get(`${idx} ${id}`) ?? 0), 0) * 100) / 100,
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
      basis: 'MRR as of the end of the range, split by app and ordered largest first',
      includeUsage: context.includeUsage,
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
export const EARNING_TYPES = [
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
/**
 * Gross earnings is the metric the rollup was built for: it is a flow, so every
 * bucket sums a disjoint slice of the ledger, and reading it from the raw table
 * meant one full pass per bucket — a dozen passes over millions of rows to
 * produce a dozen numbers.
 *
 * The bucket interiors come from `transaction_daily`, which carries `type`, so
 * the component breakdown splits the same way the total does. Only the two
 * outermost buckets have a remainder to read raw: the first bucket is clamped to
 * the requested start and the last to `now`, and every boundary between them is
 * a local midnight the rollup is keyed on.
 */
export function grossEarningsReport(context: MetricContext): MetricResponse {
  const buckets = context.window.buckets;
  const split = splitBuckets(
    buckets.map((bucket, idx) => ({ idx, from: bucket.start, to: bucket.end })),
    context.window.timeZone,
    rollupReady(context.db),
  );
  const cte = splitCte(split);
  const rollupApps = appIdFilter(context.appIds, 'r.app_id', 'erapp');
  const rawApps = appIdFilter(context.appIds, 't.app_id', 'eapp');

  const params: Record<string, unknown> = {
    ...cte.params,
    ...rollupApps.params,
    ...rawApps.params,
  };
  const typeNames = EARNING_TYPES.map((type, index) => {
    params[`etype${index}`] = type;
    return `@etype${index}`;
  });
  const typeFilter = `type IN (${typeNames.join(', ')})`;

  const rows = context.db
    .prepare(
      `WITH ${cte.sql}
       SELECT idx,
              COALESCE(SUM(gross), 0) AS gross,
              COALESCE(SUM(net), 0) AS net,
              COALESCE(SUM(CASE WHEN type = 'AppSubscriptionSale' THEN gross ELSE 0 END), 0) AS subscription,
              COALESCE(SUM(CASE WHEN type = 'AppOneTimeSale' THEN gross ELSE 0 END), 0) AS oneTime,
              COALESCE(SUM(CASE WHEN type = 'AppUsageSale' THEN gross ELSE 0 END), 0) AS usage,
              COALESCE(SUM(CASE WHEN type IN ('AppSaleAdjustment', 'AppSaleCredit') THEN gross ELSE 0 END), 0) AS adjustments
       FROM (
         SELECT b.idx AS idx, r.type AS type, r.gross_amount AS gross, r.net_amount AS net
         FROM rdays b
         JOIN transaction_daily r
           ON r.day >= b.day_from AND r.day < b.day_to
          AND r.${typeFilter}
          ${rollupApps.sql ? `AND ${rollupApps.sql}` : ''}
         UNION ALL
         SELECT e.idx AS idx, t.type AS type, t.gross_amount AS gross, t.net_amount AS net
         FROM redges e
         JOIN transactions t
           ON t.created_at >= e.lo AND t.created_at < e.hi
          AND t.${typeFilter}
          ${rawApps.sql ? `AND ${rawApps.sql}` : ''}
       )
       GROUP BY idx
       ORDER BY idx`,
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

/**
 * How MRR moved inside each bucket, as an accounting ledger rather than a level
 * (spec 2.4 — the "movement" view): a level tells you MRR fell by 400 last
 * month, and only the ledger tells you that 900 arrived, 500 was upgraded onto,
 * and 1,800 walked out.
 *
 * Built per shop-and-app pair, from the MRR card's own components read at each
 * bucket's two edges (see `pairMovementSeries`). Each pair's change lands in
 * exactly one place, so every row adds across to `Net` and `Net` is the change
 * in the MRR card across the bucket — under every filter, trials included,
 * because the two read the same sources at the same instants.
 *
 * It used to be read from the subscription event ledger, with metered usage
 * bolted on as a per-shop "up" and "down". That could not see revenue billed
 * through usage at all: a merchant signing up to a plan whose fee is billed as
 * usage added nothing to New, and leaving took nothing from Churned — both
 * landed in the usage columns, mixed in with the month-to-month swing of
 * metered consumption. Classifying the pair instead puts each where it belongs.
 *
 * Signs are kept as the change itself: losses are negative, so a reader sums a
 * row by eye instead of tracking which columns to subtract.
 */
const MOVEMENTS = [
  // A pair paying nothing before the bucket and something after: its first
  // revenue ever, a trial reaching its first charge, or a fee plan's first fee.
  ['added', 'New'],
  // The same, from a pair that had paid before and had left.
  ['reactivated', 'Reactivated'],
  // A paying pair whose price moved: a plan change, a fee tier change, or a
  // still-subscribed shop going from paying nothing to something and back.
  ['upgraded', 'Plan upgrades'],
  ['downgraded', 'Plan downgrades'],
  ['unfrozen', 'Unfrozen'],
  ['frozen', 'Frozen'],
  // A pair that was paying and is no longer a customer at all.
  ['churned', 'Churned'],
] as const;

/** Metered consumption moving for a customer who stayed. Shown only while usage is part of MRR. */
const USAGE_MOVEMENTS = [
  ['usageUp', 'Usage expansion'],
  ['usageDown', 'Usage contraction'],
] as const;

type MovementKey = (typeof MOVEMENTS)[number][0] | (typeof USAGE_MOVEMENTS)[number][0];

/** Below this a pair's MRR is nothing: a charge and its credit netting to a rounding error. */
const NOTHING = 0.005;

/**
 * Where one pair's change belongs.
 *
 * Starting and stopping are decided by the whole of the pair's MRR, because
 * that is what a customer is: a shop on a fee plan is new when its first fee
 * lands, whatever its subscription price says. Within a customer who stayed,
 * the change is split by part — price moves are plan upgrades or downgrades,
 * consumption moves are usage expansion or contraction — so a busy month for a
 * heavy shop never reads as a sale.
 */
export function classifyMovement(move: PairMovement): Array<[MovementKey, number]> {
  const start = move.plan0 + move.metered0;
  const end = move.plan1 + move.metered1;
  const change = end - start;
  const split = (): Array<[MovementKey, number]> => {
    const parts: Array<[MovementKey, number]> = [];
    const plan = move.plan1 - move.plan0;
    const metered = move.metered1 - move.metered0;
    if (plan !== 0) parts.push([plan > 0 ? 'upgraded' : 'downgraded', plan]);
    if (metered !== 0) parts.push([metered > 0 ? 'usageUp' : 'usageDown', metered]);
    return parts;
  };

  if (start <= NOTHING && end > NOTHING) {
    if (move.frozen0) return [['unfrozen', change]];
    // Still a customer the whole time, paying nothing for a while — a fee that
    // lapsed and resumed — is a price change, not a return.
    if (move.subscribed0 && move.paidBefore) return split();
    if (move.paidBefore) return [['reactivated', change]];
    return [['added', change]];
  }
  if (start > NOTHING && end <= NOTHING) {
    if (move.frozen1) return [['frozen', change]];
    if (!move.subscribed1) return [['churned', change]];
    // Still subscribed, now paying nothing: moved to a free plan, or a fee
    // that has not been billed again yet.
    return split();
  }
  return split();
}

export function mrrMovementReport(context: MetricContext): MetricResponse {
  const buckets = context.window.buckets;
  const moves = pairMovementSeries(context.db, buckets, context.asOf);

  const totals = buckets.map(() => new Map<MovementKey, number>());
  const counts = buckets.map(() => new Map<MovementKey, number>());
  for (const move of moves) {
    for (const [key, value] of classifyMovement(move)) {
      totals[move.idx]!.set(key, (totals[move.idx]!.get(key) ?? 0) + value);
      counts[move.idx]!.set(key, (counts[move.idx]!.get(key) ?? 0) + 1);
    }
  }

  const dates = buckets.map((bucket) => bucket.start.toISOString());
  const round = (value: number): number => Math.round(value * 100) / 100;
  const shown: ReadonlyArray<readonly [MovementKey, string]> = [
    ...MOVEMENTS,
    ...(context.includeUsage ? USAGE_MOVEMENTS : []),
  ];
  const cell = (idx: number, key: MovementKey): number => round(totals[idx]!.get(key) ?? 0);

  /**
   * Net is the sum of the columns as *displayed*, not an independently rounded
   * total of the same changes. The two differ by a cent often enough to matter,
   * and a ledger the reader adds across has to close: a row that lands a penny
   * short reads as a bug in the figures rather than as rounding.
   */
  const net = buckets.map((_, idx) => round(shown.reduce((sum, [key]) => sum + cell(idx, key), 0)));

  const series: NamedSeries[] = [
    ...shown.map(([key, name]) => ({
      key,
      name,
      data: dates.map((date, idx) => ({ date, value: cell(idx, key) })),
    })),
    { key: 'net', name: 'Net', data: dates.map((date, idx) => ({ date, value: net[idx]! })) },
  ];

  /**
   * What moved that no column shows: rounding alone, since every change is
   * classified into a shown column — with usage off, metered usage is not part
   * of MRR and `pairMovementSeries` never reads it. Carried as an observable
   * rather than an assurance, so a change that escapes the columns shows here.
   */
  const unattributed = round(
    moves.reduce((sum, move) => sum + (move.plan1 + move.metered1) - (move.plan0 + move.metered0), 0) -
      net.reduce((sum, value) => sum + value, 0),
  );

  // How many shops each column is made of, for the whole range: "1,200 of new
  // MRR" reads very differently from forty shops than from one.
  const shops: Record<string, number> = {};
  for (const [key] of shown) {
    shops[key] = counts.reduce((sum, bucket) => sum + (bucket.get(key) ?? 0), 0);
  }

  return buildResponse({
    metric: 'mrr_movement',
    kind: 'flow',
    format: 'money',
    window: context.window,
    values: net,
    currency: context.currency,
    series,
    meta: {
      basis:
        'each shop-and-app pair’s MRR at the start and end of each period — subscription price, plan fees billed as usage, and metered usage — classified by what changed',
      includeUsage: context.includeUsage,
      includeAnnual: context.asOf.includeAnnual,
      includeTrials: context.asOf.includeTrials,
      includeSubscriptions: context.asOf.includeSubscriptions,
      unattributed,
      shops,
      note: 'Each period’s Net equals the change in the MRR card across it, under the same filters.',
    },
  });
}
