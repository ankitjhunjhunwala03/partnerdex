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
  const series = onTrialSeries(context.db, context.bucketsWithLead, context.appIds);
  const values = context.bucketsWithLead.map((_, idx) => series.get(idx) ?? 0);
  const [leading, ...visible] = values;

  return buildResponse({
    metric: 'on_trial',
    kind: 'stock',
    format: 'count',
    window: context.window,
    values: visible,
    leadingValue: leading ?? null,
    meta: {
      definition: 'Trials started but neither converted nor cancelled as of the instant.',
      excludes: 'trials whose outcome was never recorded, which have no end instant to test',
    },
  });
}

/**
 * How far back the usage estimate looks, and the span it reports.
 *
 * Thirty days is the window `usageRecognized` already recognizes a metered
 * payment over, so an estimated trial and a live usage-priced subscription are
 * valued on one basis rather than two.
 */
const USAGE_ESTIMATE_DAYS = 30;

interface UsageEstimate {
  /** Expected billed amount per shop over `USAGE_ESTIMATE_DAYS`. */
  value: number;
  /** Live usage-priced shops the mean was taken over. */
  shops: number;
  /** How many of them billed anything. */
  consuming: number;
}

interface EstimateRow {
  appId: string;
  planName: string | null;
  shops: number;
  consuming: number;
  billed: number;
}

const planKey = (appId: string, planName: string | null) => `${appId} ${planName ?? ''}`;

/**
 * What a trial on a usage-priced plan is worth.
 *
 * A usage-priced plan carries a recurring amount of zero — that is its billing
 * mechanism, not missing data. A forecast that sums `amount` therefore prices
 * every current trial on one of them at nothing, and a pipeline made entirely
 * of them charts as a flat zero. The money is real; it simply arrives as
 * metered consumption, and the only place to read its size is what comparable
 * shops actually billed.
 *
 * The estimate is the *mean* over every live shop on the plan, including the
 * ones that consumed nothing. That is deliberate: a forecast sums expectations,
 * and on a metered plan most shops bill little or nothing while a few bill a
 * lot — the same open-ended outcome `awaiting_usage` exists to name. A median
 * would read zero whenever fewer than half consume, which is the blank chart
 * this exists to fix; a mean over consumers only would forecast every trial as
 * a whale.
 *
 * Two things it cannot know, both inherited from usage sales carrying an
 * `AppUsageRecord` id and never a subscription. A shop holding zero-priced
 * plans on one app is counted once per plan, and its consumption with it. And a
 * shop live for less than the window is counted at its partial-window spend
 * rather than extrapolated to a full one, which biases the estimate low —
 * chosen over the alternative, where a shop three days old with one large
 * charge extrapolates to a monthly rate nobody has.
 *
 * The sample is the plan's settled book, not its pipeline: shops still in trial
 * are excluded, or a plan would forecast its own trials lower the more of them
 * it had.
 */
function usageEstimates(context: MetricContext): {
  byPlan: Map<string, UsageEstimate>;
  byApp: Map<string, UsageEstimate>;
} {
  const now = context.now.toISOString();
  const params: Record<string, unknown> = {
    estimateNow: now,
    estimateFrom: new Date(
      context.now.getTime() - USAGE_ESTIMATE_DAYS * 86_400_000,
    ).toISOString(),
  };
  const appNames = context.appIds.map((id, index) => {
    params[`eapp${index}`] = id;
    return `@eapp${index}`;
  });
  const appFilter = appNames.length > 0 ? `AND s.app_id IN (${appNames.join(', ')})` : '';

  const rows = context.db
    .prepare(
      `WITH live AS (
         SELECT s.app_id AS app_id, s.plan_name AS plan_name, s.shop_id AS shop_id
         FROM subscriptions s
         WHERE s.is_test = 0
           AND s.amount <= 0
           AND s.shop_id <> ''
           AND s.activated_at IS NOT NULL
           AND s.activated_at <= @estimateNow
           AND (s.churn_at IS NULL OR s.churn_at > @estimateNow)
           -- A shop still inside its free window has not been asked to consume
           -- yet, so it is no evidence either way. Leaving trials in the sample
           -- would let a plan value its own pipeline down as the pipeline grew.
           AND s.trial_status <> 'in_trial'
           ${appFilter}
         GROUP BY s.app_id, s.plan_name, s.shop_id
       ),
       billed AS (
         SELECT t.app_id AS app_id, t.shop_id AS shop_id, SUM(t.gross_amount) AS billed
         FROM transactions t
         WHERE t.type = 'AppUsageSale'
           AND t.gross_amount > 0
           AND t.created_at > @estimateFrom
           AND t.created_at <= @estimateNow
         GROUP BY t.app_id, t.shop_id
       )
       SELECT live.app_id AS appId,
              live.plan_name AS planName,
              COUNT(*) AS shops,
              COALESCE(SUM(CASE WHEN billed.billed > 0 THEN 1 ELSE 0 END), 0) AS consuming,
              COALESCE(SUM(billed.billed), 0) AS billed
       FROM live
       LEFT JOIN billed
         ON billed.app_id = live.app_id
        AND billed.shop_id = live.shop_id
       GROUP BY live.app_id, live.plan_name`,
    )
    .all(params) as EstimateRow[];

  const byPlan = new Map<string, UsageEstimate>();
  const byApp = new Map<string, UsageEstimate>();

  for (const row of rows) {
    if (row.shops > 0) {
      byPlan.set(planKey(row.appId, row.planName), {
        value: row.billed / row.shops,
        shops: row.shops,
        consuming: row.consuming,
      });
    }
    // The app-level fallback, for a plan too new to have a book of its own.
    const app = byApp.get(row.appId) ?? { value: 0, shops: 0, consuming: 0 };
    byApp.set(row.appId, {
      value: app.value + row.billed,
      shops: app.shops + row.shops,
      consuming: app.consuming + row.consuming,
    });
  }
  for (const [appId, app] of byApp) {
    byApp.set(appId, { ...app, value: app.shops > 0 ? app.value / app.shops : 0 });
  }

  return { byPlan, byApp };
}

interface OpenTrial {
  appId: string;
  planName: string | null;
  amount: number;
  currency: string | null;
  trialEndsAt: string;
}

/**
 * The value waiting at the end of today's trial pipeline.
 *
 * Unlike `on_trial`, this is a forecast: one daily bar for the billed
 * subscription amount expected to start on that date, from today through the
 * latest currently-open trial. Empty dates remain visible as zero so the
 * distance to each expected conversion is legible.
 *
 * A trial on a priced plan is worth its price. A trial on a usage-priced one
 * has no price to be worth, and is valued at what comparable shops bill instead
 * — see `usageEstimates` for what that can and cannot know. The two are summed
 * into one bar because they are the same question to the reader, and separated
 * in `meta` because only one of them is a fact.
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

  const estimates = usageEstimates(context);
  const values = window.buckets.map(() => 0);
  const currencies = new Map<string, number>();
  let estimatedValue = 0;
  let estimatedTrials = 0;
  let unpriced = 0;
  let thinnest: UsageEstimate | null = null;

  for (const trial of trials) {
    let value = trial.amount > 0 ? trial.amount : 0;
    if (trial.amount <= 0) {
      const estimate =
        estimates.byPlan.get(planKey(trial.appId, trial.planName)) ??
        estimates.byApp.get(trial.appId) ??
        null;
      estimatedTrials += 1;
      if (estimate && estimate.value > 0) {
        value = estimate.value;
        estimatedValue += estimate.value;
        // The weakest sample behind any bar, so the reader can discount the
        // whole forecast by its worst input rather than its average one.
        if (!thinnest || estimate.consuming < thinnest.consuming) thinnest = estimate;
      } else {
        // A metered plan whose book has billed nothing at all. Zero is the
        // honest reading, but it is not the same zero as "no trials".
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
      definition: 'Billed subscription amount grouped by the expected end date of current trials.',
      basis: 'Raw billed amount, not monthly-normalized MRR.',
      ...(estimatedTrials > 0
        ? {
            estimatedTrials,
            estimatedValue: Math.round(estimatedValue * 100) / 100,
            ...(unpriced > 0 ? { unpricedTrials: unpriced } : {}),
            ...(thinnest
              ? { estimateSample: { shops: thinnest.shops, consuming: thinnest.consuming } }
              : {}),
            estimateBasis: `Usage-priced plans carry no price, so each is valued at the mean amount its plan's settled shops billed over the last ${USAGE_ESTIMATE_DAYS} days — shops that consumed nothing included, shops still trialling excluded. An estimate, not a booked amount.`,
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
