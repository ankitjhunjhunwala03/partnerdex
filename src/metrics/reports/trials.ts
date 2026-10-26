import { bucketsCte, onTrialSeries } from '../asof.js';
import type { MetricContext } from '../context.js';
import { buildResponse, type MetricResponse } from '../response.js';
import { addInterval, resolveWindow, startOfInterval } from '../time.js';

/**
 * Trials (spec 4.11).
 *
 * The Partner API does not report trial periods. A trial is inferred at sync
 * time from the gap between a subscription activating and its first paid
 * charge landing: no gap means the merchant paid immediately, a gap means they
 * were trialling. `TRIAL_MIN_GAP_DAYS` sets the threshold, which also absorbs
 * the short lag between a charge and its transaction being recorded.
 *
 * The resulting statuses live on `subscriptions.trial_status`:
 *   converted      - a payment eventually landed: a subscription sale on a
 *                    priced plan, or the first metered usage on a usage-priced
 *                    one, which is the only way a zero-priced plan is ever paid
 *   canceled       - the subscription ended before any payment
 *   in_trial       - still inside the free period right now
 *   awaiting_usage - a usage-priced plan whose free window closed without any
 *                    usage billed. Nothing forces a decision on a metered plan,
 *                    so the outcome is still open: neither converted nor lost,
 *                    and outside the conversion ratio until it resolves
 *   unknown        - activated, never billed, never cancelled, past its billing
 *                    date (a data gap rather than a real outcome; excluded)
 */

interface TrialRow {
  idx: number;
  started: number;
  converted: number;
  canceled: number;
}

function trialCounts(context: MetricContext): Map<number, TrialRow> {
  const buckets = context.window.buckets;
  const cte = bucketsCte(buckets);

  const params: Record<string, unknown> = { ...cte.params };
  const appNames = context.appIds.map((id, index) => {
    params[`tapp${index}`] = id;
    return `@tapp${index}`;
  });
  const appFilter = appNames.length > 0 ? `AND s.app_id IN (${appNames.join(', ')})` : '';

  // Bucketed by when the trial started, so a conversion is credited to the
  // cohort that produced it rather than to the month the money arrived.
  const rows = context.db
    .prepare(
      `WITH ${cte.sql}
       SELECT b.idx AS idx,
              COUNT(s.charge_id) AS started,
              COALESCE(SUM(CASE WHEN s.trial_status = 'converted' THEN 1 ELSE 0 END), 0) AS converted,
              COALESCE(SUM(CASE WHEN s.trial_status = 'canceled'  THEN 1 ELSE 0 END), 0) AS canceled
       FROM buckets b
       LEFT JOIN subscriptions s
         ON s.is_test = 0
        AND s.trial_started_at IS NOT NULL
        AND s.trial_started_at >= b.bucket_from
        AND s.trial_started_at < b.as_of
        ${appFilter}
       GROUP BY b.idx
       ORDER BY b.idx`,
    )
    .all(params) as TrialRow[];

  return new Map(rows.map((row) => [row.idx, row]));
}

export function trialsReport(context: MetricContext): MetricResponse {
  const byIndex = trialCounts(context);
  const buckets = context.window.buckets;
  const dates = buckets.map((bucket) => bucket.start.toISOString());
  const values = buckets.map((_, idx) => byIndex.get(idx)?.started ?? 0);

  const converted = buckets.reduce((total, _, idx) => total + (byIndex.get(idx)?.converted ?? 0), 0);
  const canceled = buckets.reduce((total, _, idx) => total + (byIndex.get(idx)?.canceled ?? 0), 0);
  const decided = converted + canceled;

  return buildResponse({
    metric: 'trials',
    kind: 'flow',
    format: 'count',
    window: context.window,
    values,
    series: [
      {
        key: 'converted',
        name: 'Converted',
        data: dates.map((date, idx) => ({ date, value: byIndex.get(idx)?.converted ?? 0 })),
      },
      {
        key: 'canceled',
        name: 'Cancelled',
        data: dates.map((date, idx) => ({ date, value: byIndex.get(idx)?.canceled ?? 0 })),
      },
    ],
    meta: {
      converted,
      canceled,
      // Trials still running have no outcome yet and stay out of the rate.
      conversionRate: decided > 0 ? Math.round((converted / decided) * 10000) / 100 : 0,
      minGapDays: 'TRIAL_MIN_GAP_DAYS',
      note: 'Trials are inferred from the gap between activation and first payment; the Partner API does not expose trial length.',
    },
  });
}

/**
 * How many trials were running at each instant — a stock, where `trials` is the
 * flow that feeds it. This is the number that answers "how big is the pipeline
 * right now", which trials-started cannot: a bucket with 40 starts and 40
 * decisions has an empty pipeline.
 */
export function onTrialReport(context: MetricContext): MetricResponse {
  const series = onTrialSeries(context.db, context.bucketsWithLead, context.appIds, context.window.timeZone);
  const values = context.bucketsWithLead.map((_, idx) => series.get(idx) ?? 0);
  const [leading, ...visible] = values;
  // What today's trials are worth, carried beside the count so one card says
  // both how many and how much — the Trialing report, read as one figure.
  const pipeline = trialingReport(context).value;

  return buildResponse({
    metric: 'on_trial',
    kind: 'stock',
    format: 'count',
    window: context.window,
    values: visible,
    leadingValue: leading ?? null,
    // For the money figure carried beneath the count.
    currency: context.currency,
    meta: {
      secondary: { value: pipeline, format: 'money', label: 'a month if every current trial pays' },
      definition: 'Trials started but neither converted nor cancelled as of the instant.',
      excludes: 'trials whose outcome was never recorded, which have no end instant to test',
    },
  });
}

interface UsageEstimate {
  /** Mean monthly MRR of the plan's paying shops: what a converted trial is worth. */
  value: number;
  /** Live, settled shops on the plan. */
  shops: number;
  /** How many of them are paying anything right now — the ones the mean is taken over. */
  paying: number;
}

interface EstimateRow {
  appId: string;
  planName: string | null;
  shops: number;
  paying: number;
  mrr: number;
}

const planKey = (appId: string, planName: string | null) => `${appId} ${planName ?? ''}`;

/**
 * The first plan fee a shop-and-app pair was billed at or after `since`, as
 * its recognized monthly rate: the tier a subscription starts on.
 *
 * An app can run its own tiers inside one zero-priced Shopify plan — a base
 * fee, then automatic upgrades billed as further usage charges — so the first
 * fee is the subscription a trial converts into, and what comes after is a
 * change of tier. Metered spend, and credits, are not a fee.
 */
const firstFee = (pair: string, since: string, until?: string) => `(
  SELECT r.monthly_amount FROM usage_recognized_rows r
   WHERE ${pair}
     AND r.kind <> 'metered'
     AND r.monthly_amount > 0.005
     AND r.created_at >= ${since}
     ${until ? `AND r.created_at <= ${until}` : ''}
   ORDER BY r.created_at, r.monthly_amount
   LIMIT 1
)`;

/**
 * What a trial on a zero-priced plan is worth if it converts.
 *
 * A zero-priced plan carries no price — it is paid through usage charges: a
 * fee, top-ups to a higher tier, or metered spend. So the only place to read
 * its size is what the plan's paying shops are paying now, read as the same
 * recognized monthly rate the MRR card adds up (see `usage/recognition.ts`).
 *
 * Only the first fee counts (see `firstFee`). A trial is worth the subscription
 * it converts into, as a priced plan's trial is worth its price. Metered spend
 * is usage revenue on top, and an app's automatic upgrades to higher tiers come
 * later: averaging today's whole bill valued a trial on a $40 starting tier at
 * the $120 its upgraded shops pay.
 *
 * The mean is taken over the shops that *pay*, because the question a trial
 * forecast answers is "what does this become if it converts", the same
 * question a priced trial's price answers. Averaging in the plan's shops that
 * pay nothing — a fee plan approved but never billed, which on some books is
 * most of them — mixed a conversion rate into the price and valued a trial on
 * a $15 plan at a few dollars. And reading what was *billed* in the last 30
 * days instead of the recognized rate valued a yearly fee as a year one month
 * and nothing the next, and a shop billed twice in a window at double.
 *
 * The sample is the plan's settled book, not its pipeline: shops still in
 * trial are excluded. A plan too new to have a paying shop falls back to the
 * app's zero-priced plans together, and with none of those either, the trial
 * is left unpriced rather than guessed.
 */
function usageEstimates(context: MetricContext): {
  byPlan: Map<string, UsageEstimate>;
  byApp: Map<string, UsageEstimate>;
} {
  const params: Record<string, unknown> = { estimateNow: context.now.toISOString() };
  const appNames = context.appIds.map((id, index) => {
    params[`eapp${index}`] = id;
    return `@eapp${index}`;
  });
  const appFilter = appNames.length > 0 ? `AND s.app_id IN (${appNames.join(', ')})` : '';

  const rows = context.db
    .prepare(
      `WITH live AS (
         SELECT s.app_id AS app_id, s.plan_name AS plan_name, s.shop_id AS shop_id,
                MIN(s.activated_at) AS since
         FROM subscriptions s
         WHERE s.is_test = 0
           AND s.amount <= 0
           AND s.shop_id <> ''
           AND s.activated_at IS NOT NULL
           AND s.activated_at <= @estimateNow
           AND (s.churn_at IS NULL OR s.churn_at > @estimateNow)
           -- A shop still inside its free window is the pipeline, not the
           -- book: it would value the plan's trials by its own trials.
           AND s.trial_status <> 'in_trial'
           ${appFilter}
         GROUP BY s.app_id, s.plan_name, s.shop_id
       ),
       started AS (
         SELECT live.app_id AS app_id, live.plan_name AS plan_name,
                ${firstFee('r.app_id = live.app_id AND r.shop_id = live.shop_id', 'live.since', '@estimateNow')} AS fee
         FROM live
       )
       SELECT app_id AS appId,
              plan_name AS planName,
              COUNT(*) AS shops,
              COALESCE(SUM(CASE WHEN fee IS NOT NULL THEN 1 ELSE 0 END), 0) AS paying,
              COALESCE(SUM(fee), 0) AS mrr
       FROM started
       GROUP BY app_id, plan_name`,
    )
    .all(params) as EstimateRow[];

  const byPlan = new Map<string, UsageEstimate>();
  const byApp = new Map<string, EstimateRow>();

  for (const row of rows) {
    if (row.paying > 0) {
      byPlan.set(planKey(row.appId, row.planName), {
        value: row.mrr / row.paying,
        shops: row.shops,
        paying: row.paying,
      });
    }
    // The app-level fallback, for a plan too new to have a paying shop.
    const app = byApp.get(row.appId) ?? { ...row, shops: 0, paying: 0, mrr: 0 };
    byApp.set(row.appId, { ...app, shops: app.shops + row.shops, paying: app.paying + row.paying, mrr: app.mrr + row.mrr });
  }

  const apps = new Map<string, UsageEstimate>();
  for (const [appId, app] of byApp) {
    if (app.paying > 0) apps.set(appId, { value: app.mrr / app.paying, shops: app.shops, paying: app.paying });
  }
  return { byPlan, byApp: apps };
}

/** What one trial adds to MRR if it converts, and whether that is an estimate. */
interface TrialValue {
  value: number;
  /** A zero-priced plan, valued from its plan's paying shops. */
  estimated: boolean;
  /** Read from this sample; null for a priced plan, or one with nothing to read. */
  sample: UsageEstimate | null;
}

/**
 * Values trials the way the Trialing card does: a priced plan at its monthly
 * price, a zero-priced one at what its plan's paying shops carry now (see
 * `usageEstimates`). Shared so that every card puts the same number on the
 * same trial.
 */
function trialValuer(
  context: MetricContext,
): (trial: { appId: string; planName: string | null; amount: number; monthlyAmount: number }) => TrialValue {
  const estimates = usageEstimates(context);
  return (trial) => {
    if (trial.amount > 0) return { value: trial.monthlyAmount, estimated: false, sample: null };
    const estimate =
      estimates.byPlan.get(planKey(trial.appId, trial.planName)) ?? estimates.byApp.get(trial.appId) ?? null;
    return estimate && estimate.value > 0
      ? { value: estimate.value, estimated: true, sample: estimate }
      : { value: 0, estimated: true, sample: null };
  };
}

export interface TrialPipelinePoint {
  /** Trials that started in the bucket, at what each would add to MRR. */
  started: number;
  /** Trials that ended in the bucket and went on to pay. */
  converted: number;
  /** Trials that ended in the bucket without paying — ran out or were cancelled. */
  expired: number;
  /** How many trials each figure is made of. */
  counts: { started: number; converted: number; expired: number };
}

/**
 * The trial pipeline as flows: what entered it in each bucket, and what left
 * it — into paid revenue, or not.
 *
 * Valued in the Trialing card's terms rather than read from MRR, because MRR
 * cannot see most trials: a zero-priced plan carries no price until its first
 * fee lands, often after the trial has ended and never at the estimated figure.
 * So the pipeline is reported beside the MRR ledger and never added into it; a
 * converted trial's real revenue reaches MRR as New when it is billed.
 *
 * A trial is valued as the Trialing card values it, except a converted one on a
 * zero-priced plan, which carries the first fee it was actually billed: that
 * is a fact, and the figure a reader checks the column against.
 *
 * A trial leaves the pipeline when it ends, or when it is cancelled if that is
 * sooner, and is classed by the outcome recorded on it. A $0-plan trial whose
 * window closed with no fee billed (`awaiting_usage`) has expired: the free
 * period is over and it did not pay. If a fee lands later, the re-derive marks
 * it converted, and it moves to Trial conversions on the same date. One whose
 * outcome was never recorded (`unknown`) has not left.
 */
export function trialPipelineSeries(context: MetricContext): TrialPipelinePoint[] {
  const buckets = context.window.buckets;
  const cte = bucketsCte(buckets);
  const params: Record<string, unknown> = { ...cte.params };
  const appNames = context.appIds.map((id, index) => {
    params[`tpapp${index}`] = id;
    return `@tpapp${index}`;
  });
  const appFilter = appNames.length > 0 ? `AND s.app_id IN (${appNames.join(', ')})` : '';
  const ended = `MIN(s.trial_ends_at, COALESCE(s.churn_at, s.trial_ends_at))`;

  const rows = context.db
    .prepare(
      `WITH ${cte.sql},
       trials AS (
         SELECT s.app_id AS appId, s.plan_name AS planName, s.amount AS amount,
                s.monthly_amount AS monthlyAmount, s.trial_status AS status,
                s.trial_started_at AS startedAt,
                CASE WHEN s.trial_status IN ('converted', 'canceled', 'awaiting_usage') THEN ${ended} END AS endedAt,
                -- What a converted trial on a zero-priced plan was actually
                -- billed: its first fee, from the trial's start.
                CASE WHEN s.trial_status = 'converted' AND s.amount <= 0
                     THEN ${firstFee('r.app_id = s.app_id AND r.shop_id = s.shop_id', 's.trial_started_at')} END AS paidFee
         FROM subscriptions s
         WHERE s.is_test = 0
           AND s.trial_started_at IS NOT NULL
           AND s.trial_ends_at IS NOT NULL
           ${appFilter}
       )
       SELECT b.idx AS idx, 'started' AS kind, t.appId, t.planName, t.amount, t.monthlyAmount,
              NULL AS paidFee
       FROM buckets b JOIN trials t ON t.startedAt >= b.bucket_from AND t.startedAt < b.as_of
       UNION ALL
       SELECT b.idx, CASE WHEN t.status = 'converted' THEN 'converted' ELSE 'expired' END,
              t.appId, t.planName, t.amount, t.monthlyAmount, t.paidFee
       FROM buckets b JOIN trials t ON t.endedAt >= b.bucket_from AND t.endedAt < b.as_of`,
    )
    .all(params) as Array<{
    idx: number;
    kind: 'started' | 'converted' | 'expired';
    appId: string;
    planName: string | null;
    amount: number;
    monthlyAmount: number;
    paidFee: number | null;
  }>;

  const valueOf = trialValuer(context);
  const points: TrialPipelinePoint[] = buckets.map(() => ({
    started: 0,
    converted: 0,
    expired: 0,
    counts: { started: 0, converted: 0, expired: 0 },
  }));
  for (const row of rows) {
    const point = points[row.idx]!;
    // A conversion is read from what was billed; only a trial with no outcome
    // to read, or a fee that never arrived, falls back to the estimate.
    point[row.kind] += row.paidFee ?? valueOf(row).value;
    point.counts[row.kind] += 1;
  }
  return points;
}

interface OpenTrial {
  appId: string;
  planName: string | null;
  amount: number;
  /** The price as a monthly rate: an annual plan at a twelfth, as MRR reads it. */
  monthlyAmount: number;
  currency: string | null;
  trialEndsAt: string;
}

/**
 * The value waiting at the end of today's trial pipeline.
 *
 * Unlike `on_trial`, this is a forecast: one daily bar for the MRR expected to
 * start on that date if the trials ending then convert, from today through the
 * latest currently-open trial. Empty dates remain visible as zero so the
 * distance to each expected conversion is legible.
 *
 * Every trial is valued as the monthly rate it would add to MRR, the same unit
 * as the MRR card: a priced plan at its monthly price — an annual one at a
 * twelfth, not the year it bills up front — and a zero-priced plan at what its
 * plan's paying shops carry (see `usageEstimates`). The two are summed into one
 * bar because they are the same question to the reader, and separated in
 * `meta` because only one of them is a fact.
 */
export function trialingReport(context: MetricContext): MetricResponse {
  const params: Record<string, unknown> = { forecastNow: context.now.toISOString() };
  const appNames = context.appIds.map((id, index) => {
    params[`fapp${index}`] = id;
    return `@fapp${index}`;
  });
  const appFilter = appNames.length > 0 ? `AND s.app_id IN (${appNames.join(', ')})` : '';

  const trials = context.db
    .prepare(
      `SELECT s.app_id AS appId,
              s.plan_name AS planName,
              s.amount AS amount,
              s.monthly_amount AS monthlyAmount,
              s.currency AS currency,
              s.trial_ends_at AS trialEndsAt
       FROM subscriptions s
       WHERE s.is_test = 0
         AND s.trial_status = 'in_trial'
         AND s.trial_ends_at IS NOT NULL
         AND s.trial_ends_at > @forecastNow
         ${appFilter}
       ORDER BY s.trial_ends_at`,
    )
    .all(params) as OpenTrial[];

  const timeZone = context.window.timeZone;
  const firstDay = startOfInterval(context.now, 'day', timeZone);
  const latestEnd = trials.at(-1)?.trialEndsAt ?? null;
  const lastDay = latestEnd
    ? startOfInterval(new Date(latestEnd), 'day', timeZone)
    : firstDay;
  const end = addInterval(lastDay, 'day', 1, timeZone);
  const window = resolveWindow({
    period: 'custom',
    start: firstDay.toISOString(),
    end: end.toISOString(),
    interval: 'day',
    timeZone,
    allTimeStart: firstDay.toISOString().slice(0, 10),
    now: context.now,
    allowFutureDates: true,
  });

  const valueOf = trialValuer(context);
  const values = window.buckets.map(() => 0);
  const currencies = new Map<string, number>();
  let estimatedValue = 0;
  let estimatedTrials = 0;
  let unpriced = 0;
  let thinnest: UsageEstimate | null = null;

  for (const trial of trials) {
    const { value, estimated, sample } = valueOf(trial);
    if (estimated) {
      estimatedTrials += 1;
      if (sample) {
        estimatedValue += value;
        // The weakest sample behind any bar, so the reader can discount the
        // whole forecast by its worst input rather than its average one.
        if (!thinnest || sample.paying < thinnest.paying) thinnest = sample;
      } else {
        // A plan, and an app, with no paying shop to read a price from. Zero
        // is the honest reading, but it is not the same zero as "no trials".
        unpriced += 1;
      }
    }

    const at = new Date(trial.trialEndsAt).getTime();
    const idx = window.buckets.findIndex(
      (bucket) => at >= bucket.start.getTime() && at < bucket.end.getTime(),
    );
    if (idx >= 0) values[idx] = (values[idx] ?? 0) + value;

    if (trial.currency) currencies.set(trial.currency, (currencies.get(trial.currency) ?? 0) + 1);
  }

  const ranked = [...currencies.entries()].sort((a, b) => b[1] - a[1]);

  return buildResponse({
    metric: 'trialing',
    kind: 'flow',
    format: 'money',
    window,
    values,
    currency: ranked[0]?.[0] ?? context.currency,
    now: context.now,
    meta: {
      trials: trials.length,
      mixedCurrencies: ranked.length > 1,
      definition: 'The MRR current trials would add if they convert, grouped by their expected end date.',
      basis: 'Monthly rate, as MRR reads it: annual plans at a twelfth.',
      ...(estimatedTrials > 0
        ? {
            estimatedTrials,
            estimatedValue: Math.round(estimatedValue * 100) / 100,
            ...(unpriced > 0 ? { unpricedTrials: unpriced } : {}),
            ...(thinnest
              ? { estimateSample: { shops: thinnest.shops, paying: thinnest.paying } }
              : {}),
            estimateBasis:
              'Plans priced at $0 are paid through usage charges, so each is valued at the mean first plan fee of its plan’s shops — the tier a subscription starts on, with later automatic upgrades and metered usage left out. Shops still trialling, and shops never billed a fee, are left out of the mean. An estimate, not a booked amount.',
          }
        : {}),
    },
  });
}

/**
 * Trial conversion rate as its own time series, bucketed by trial start so each
 * point answers "of the trials that began here, what share converted?".
 */
export function trialConversionReport(context: MetricContext): MetricResponse {
  const byIndex = trialCounts(context);
  const buckets = context.window.buckets;

  const values = buckets.map((_, idx) => {
    const row = byIndex.get(idx);
    const decided = (row?.converted ?? 0) + (row?.canceled ?? 0);
    return decided > 0 ? ((row?.converted ?? 0) / decided) * 100 : 0;
  });

  const converted = buckets.reduce((total, _, idx) => total + (byIndex.get(idx)?.converted ?? 0), 0);
  const canceled = buckets.reduce((total, _, idx) => total + (byIndex.get(idx)?.canceled ?? 0), 0);
  const decided = converted + canceled;

  return buildResponse({
    metric: 'trial_conversion_rate',
    kind: 'stock',
    format: 'percent',
    window: context.window,
    values,
    // A rate is neither a level nor a total. The last bucket is always the
    // least resolved — trials started there have had the least time to decide —
    // so the headline is the rate across the whole window instead.
    summaryOverride: decided > 0 ? (converted / decided) * 100 : 0,
    meta: {
      converted,
      canceled,
      denominator: 'trials with a decided outcome (converted or cancelled)',
      summaryBasis: 'whole window, not the final bucket',
      note: 'Recent buckets are provisional: trials started there may not have resolved yet.',
    },
  });
}
