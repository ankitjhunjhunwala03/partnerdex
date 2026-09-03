import { getDb, type Db } from '../db/index.js';
import { resolveScopedAppIds } from '../sync/index.js';
import { listChannels, recordDeliveryOutcome, webhookUrlFor } from './store.js';
import { buildMessage, postToSlack, type SubscriptionNotice } from './slack.js';
import { topicByKey } from './topics.js';
import { getConfig } from '../config.js';

/**
 * Deciding what to say, and saying it exactly once.
 *
 * The hard part is not the HTTP request. `customer_events` is dropped and
 * rewritten on every sync, so "what is new since last time" is not a question
 * that table can answer — every row in it is new every time. Three rules stand
 * in for the timestamp comparison that would otherwise do the job:
 *
 *   1. **The watermark.** A topic only reports events that occurred after it was
 *      switched on. Without this, enabling a toggle would replay every
 *      subscription the account has ever had into a Slack channel.
 *
 *   2. **The ledger.** Event ids are deterministic, so an id already recorded in
 *      `notification_deliveries` survives the rebuild that the event itself does
 *      not. That is what makes this at-most-once rather than once-per-sync.
 *
 *   3. **Suppressed events are invisible.** A plan change reaches the feed as a
 *      cancellation, and the compiler has already marked that cancel as not-churn.
 *      Reading through the same `suppressed = 0` filter every report uses is why
 *      an upgrade announces itself as an upgrade rather than as a lost customer
 *      followed by a new one.
 */

/**
 * The most messages one channel will be sent in a single pass.
 *
 * A backlog this large means something unusual — a first sync after a long
 * outage — and pouring hundreds of messages into a channel would bury the ones
 * that matter as thoroughly as sending none. The rest are not dropped; they are
 * still pending, and the next sync picks up where this one stopped.
 */
const MAX_PER_CHANNEL_PER_RUN = 50;

/** Slack accepts about one message per second per webhook. Stay under it. */
const SEND_SPACING_MS = 350;

/**
 * Deliberately *not* unref'd. A one-off `partnerdex sync` has nothing else
 * holding the event loop open, so an unref'd spacing timer would let the
 * process exit between two messages — delivering the first, silently dropping
 * the rest, and leaving no error behind to explain it.
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface PendingRow {
  event_id: string;
  type: string;
  occurred_at: string;
  shop_id: string;
  app_id: string;
  charge_id: string;
  plan_name: string | null;
  net_change: number | null;
  currency: string | null;
  shop_name: string | null;
  shop_domain: string | null;
  app_name: string | null;
  amount: number | null;
  billing_interval: string | null;
  trial_ends_at: string | null;
  prev_plan_name: string | null;
  prev_amount: number | null;
  prev_billing_interval: string | null;
  /** JSON, and the only carrier a review event has — it touches no charge. */
  detail: string | null;
}

/**
 * The one event whose timestamp is a calendar date rather than an instant: the
 * App Store publishes the day a review was posted and not the time, so
 * `appstore/events.ts` stamps it at that day's midnight.
 */
const DAY_STAMPED_EVENT_TYPE = 'review_posted';

const MS_PER_HOUR = 3_600_000;

/**
 * How far back an event may sit and still count as news (`notificationMaxAgeHours`).
 *
 * A review posted at 23:00 is stamped 23 hours before it happened, and the sweep
 * that finds it runs at most `reviewSweepHours` later, so by the time it is
 * first seen its apparent age can exceed a day without it being stale at all.
 * Judging it on the same clock as a Partner API event — which carries a true
 * instant — would drop most review notifications on the floor. It gets the
 * length of its own day and one sweep on top.
 */
function stalenessCutoffs(now: Date): { instant: string; dayStamped: string } {
  const { runtime } = getConfig();
  if (runtime.notificationMaxAgeHours === 0) {
    return { instant: '', dayStamped: '' };
  }
  const back = (hours: number) => new Date(now.getTime() - hours * MS_PER_HOUR).toISOString();
  return {
    instant: back(runtime.notificationMaxAgeHours),
    dayStamped: back(runtime.notificationMaxAgeHours + 24 + runtime.reviewSweepHours),
  };
}

/**
 * Events a channel has not been told about yet.
 *
 * The subscription joins are what turn an event into a message worth reading:
 * `customer_events.plan_amount` is the *normalized monthly* figure MRR sums, so
 * an annual plan reads as 24.92 there. A merchant on a $299/year plan should be
 * announced as being on a $299/year plan, so the price as billed comes from
 * `subscriptions` and the monthly delta rides alongside it as `net_change`.
 */
function pendingFor(
  db: Db,
  channelId: string,
  eventTypes: readonly string[],
  enabledAt: string,
  appIds: string[],
  now: Date,
): PendingRow[] {
  const typeList = eventTypes.map((_, i) => `@type${i}`).join(', ');
  const params: Record<string, unknown> = { channelId, enabledAt, cap: MAX_PER_CHANNEL_PER_RUN };
  eventTypes.forEach((type, i) => {
    params[`type${i}`] = type;
  });

  const cutoffs = stalenessCutoffs(now);
  params.freshEnough = cutoffs.instant;
  params.freshEnoughDayStamped = cutoffs.dayStamped;
  params.dayStamped = DAY_STAMPED_EVENT_TYPE;

  const appList = appIds.map((_, i) => `@napp${i}`).join(', ');
  appIds.forEach((id, i) => {
    params[`napp${i}`] = id;
  });
  const inScope = appIds.length > 0 ? `IN (${appList})` : 'IS NOT NULL';

  const rows = db
    .prepare(
      `SELECT e.event_id, e.type, e.occurred_at, e.shop_id, e.app_id, e.charge_id,
              e.plan_name, e.net_change, e.currency, e.detail,
              sh.name AS shop_name,
              sh.myshopify_domain AS shop_domain,
              ap.name AS app_name,
              sub.amount AS amount,
              sub.billing_interval AS billing_interval,
              sub.trial_ends_at AS trial_ends_at,
              prev.plan_name AS prev_plan_name,
              prev.amount AS prev_amount,
              prev.billing_interval AS prev_billing_interval
         FROM customer_events e
         LEFT JOIN shops sh ON sh.id = e.shop_id
         LEFT JOIN apps ap ON ap.id = e.app_id
         LEFT JOIN subscriptions sub ON sub.charge_id = e.charge_id
         LEFT JOIN subscriptions prev ON prev.charge_id = e.prev_charge_id
        WHERE e.suppressed = 0
          AND e.type IN (${typeList})
          AND e.occurred_at > @enabledAt
          AND e.occurred_at >
              CASE WHEN e.type = @dayStamped THEN @freshEnoughDayStamped ELSE @freshEnough END
          AND e.app_id ${inScope}
          AND NOT EXISTS (
                SELECT 1 FROM notification_deliveries d
                 WHERE d.channel_id = @channelId AND d.event_id = e.event_id
              )
        ORDER BY e.occurred_at, e.event_id
        LIMIT @cap`,
    )
    .all(params) as PendingRow[];

  // The cap can fall in the middle of one instant, and events sharing an instant
  // are exactly the ones `collapse` needs to see together. Hold the trailing
  // instant back for the next run rather than reporting half of it — unless it
  // is the only instant here, in which case holding it back would mean never
  // making progress at all.
  if (rows.length === MAX_PER_CHANNEL_PER_RUN) {
    const lastAt = rows[rows.length - 1]!.occurred_at;
    const trimmed = rows.filter((row) => row.occurred_at !== lastAt);
    if (trimmed.length > 0) return trimmed;
  }
  return rows;
}

export interface Notice {
  notice: SubscriptionNotice;
  /**
   * Every event this one message accounts for. More than one when a start was
   * reported twice — see `collapse`.
   */
  eventIds: string[];
}

function toNotice(row: PendingRow): SubscriptionNotice {
  return {
    eventId: row.event_id,
    type: row.type,
    occurredAt: row.occurred_at,
    shopId: row.shop_id,
    shopName: row.shop_name,
    shopDomain: row.shop_domain,
    appId: row.app_id,
    appName: row.app_name,
    planName: row.plan_name,
    amount: row.amount,
    billingInterval: row.billing_interval,
    currency: row.currency,
    netChange: row.net_change,
    previousPlanName: row.prev_plan_name,
    previousAmount: row.prev_amount,
    previousBillingInterval: row.prev_billing_interval,
    // Only a trial start is waiting on a trial to end. The column is populated
    // on converted and cancelled trials too, where it is history.
    trialEndsAt: row.type === 'trial_started' ? row.trial_ends_at : null,
    detail: parseDetail(row.detail),
  };
}

/** Detail is written by us, but a malformed blob must not stop a delivery. */
function parseDetail(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * One merchant action, one message.
 *
 * A subscription that opens with a free period produces two events at the very
 * same instant: `subscribed`, because a charge activated, and `trial_started`,
 * because `derive.ts` reads the gap to the first payment as a trial. Both are
 * correct and the ledger needs both — but a merchant who signed up once should
 * not ping Slack twice, so the pair is announced as the trial it is.
 *
 * The same instant can also carry a tier move rather than a start: a merchant
 * who switches plan mid-trial keeps their unused trial days, so Shopify opens a
 * fresh charge and `upgraded` lands beside a `trial_started` too. That pair
 * collapses the other way round — the move is the news, the trial is the
 * circumstance — but it collapses, which is the point. Only starts were paired
 * before, so any activation the compiler did not label `subscribed` sent two
 * messages for one merchant action.
 *
 * The suppressed event id still goes into the delivery ledger, so it cannot
 * resurface as an unsent event on the next pass.
 */
export function collapse(rows: PendingRow[]): Notice[] {
  const STARTS = new Set(['subscribed', 'resubscribed']);
  /** Activations that are a move between plans, not the start of one. */
  const MOVES = new Set(['upgraded', 'downgraded']);

  const groups = new Map<string, PendingRow[]>();
  const order: string[] = [];
  for (const row of rows) {
    const key = `${row.app_id}|${row.shop_id}|${row.charge_id}|${row.occurred_at}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(key, [row]);
      order.push(key);
    }
  }

  const notices: Notice[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    const trial = group.find((row) => row.type === 'trial_started');
    const start = group.find((row) => STARTS.has(row.type));
    const move = group.find((row) => MOVES.has(row.type));

    if (trial && (start || move)) {
      // `toNotice` reads `trialEndsAt` off the trial row's own type, so the
      // relabel below has to come after it or a restarted trial would lose the
      // date it ends on.
      const notice = toNotice(move ?? trial);
      if (!move && start!.type === 'resubscribed') notice.type = 'trial_restarted';
      notices.push({ notice, eventIds: group.map((row) => row.event_id) });
      continue;
    }
    for (const row of group) {
      notices.push({ notice: toNotice(row), eventIds: [row.event_id] });
    }
  }

  return notices;
}

export interface DispatchSummary {
  /** Channels with at least one topic switched on. */
  channels: number;
  sent: number;
  /** Left pending, to be retried on the next sync. */
  deferred: number;
  /** Recorded as undeliverable so they stop being retried. */
  retired: number;
}

const EMPTY: DispatchSummary = { channels: 0, sent: 0, deferred: 0, retired: 0 };

function recordDelivery(
  db: Db,
  channelId: string,
  eventIds: string[],
  ok: boolean,
  error: string | null,
): void {
  const statement = db.prepare(
    `INSERT INTO notification_deliveries (channel_id, event_id, delivered_at, ok, error)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(channel_id, event_id) DO NOTHING`,
  );
  const at = new Date().toISOString();
  const write = db.transaction(() => {
    for (const id of eventIds) statement.run(channelId, id, at, ok ? 1 : 0, error);
  });
  write();
}

async function dispatchChannel(
  db: Db,
  channel: ReturnType<typeof listChannels>[number],
  appIds: string[],
  summary: DispatchSummary,
  now: Date,
): Promise<void> {
  const url = webhookUrlFor(channel.id, db);
  if (!url) return;

  for (const topicKey of channel.topics) {
    const topic = topicByKey(topicKey);
    if (!topic) continue;

    const enabledAt = (
      db
        .prepare(
          'SELECT enabled_at FROM notification_subscriptions WHERE channel_id = ? AND topic = ?',
        )
        .get(channel.id, topicKey) as { enabled_at: string } | undefined
    )?.enabled_at;
    if (!enabledAt) continue;

    const rows = pendingFor(db, channel.id, topic.eventTypes, enabledAt, appIds, now);
    if (rows.length === 0) continue;

    for (const { notice, eventIds } of collapse(rows)) {
      const result = await postToSlack(url, buildMessage(notice));

      if (result.ok) {
        recordDelivery(db, channel.id, eventIds, true, null);
        recordDeliveryOutcome(channel.id, { at: new Date().toISOString(), error: null }, db);
        summary.sent += 1;
        await sleep(SEND_SPACING_MS);
        continue;
      }

      recordDeliveryOutcome(channel.id, { at: new Date().toISOString(), error: result.error }, db);

      if (result.permanent) {
        // The webhook will refuse this message however often it is offered.
        // Retire it and carry on, so one bad event cannot wedge the queue.
        recordDelivery(db, channel.id, eventIds, false, result.error);
        summary.retired += 1;
        continue;
      }

      // Transient: leave everything after this point pending and stop, so the
      // channel's events keep arriving in the order they happened.
      summary.deferred += 1;
      console.warn(
        `[partnerdex] notifications paused for "${channel.name}": ${result.error ?? 'unknown error'}`,
      );
      return;
    }
  }
}

let inFlight: Promise<DispatchSummary> | null = null;

/**
 * Send everything owing, to every channel that asked for it.
 *
 * Never runs twice at once: a manual test and a completing sync can arrive
 * together, and two passes over the same pending set would race on the ledger.
 */
export function dispatchPending(
  db: Db = getDb(),
  options: { now?: Date } = {},
): Promise<DispatchSummary> {
  if (inFlight) return inFlight;
  inFlight = run(db, options.now ?? new Date()).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function run(db: Db, now: Date): Promise<DispatchSummary> {
  const channels = listChannels(db).filter((channel) => channel.topics.length > 0);
  if (channels.length === 0) return { ...EMPTY };

  const appIds = resolveScopedAppIds(db);
  const summary: DispatchSummary = { ...EMPTY, channels: channels.length };

  for (const channel of channels) {
    try {
      await dispatchChannel(db, channel, appIds, summary, now);
    } catch (cause) {
      // One channel's failure is not the other channels' problem.
      console.error(`[partnerdex] notification dispatch failed for "${channel.name}":`, cause);
    }
  }

  return summary;
}
