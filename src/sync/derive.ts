import { refreshUsageRecognized } from '../usage/recognition.js';
import { loadPlanIntervals } from '../usage/planIntervals.js';
import { getConfig } from '../config.js';
import { readSyncState, writeSyncState, type Db } from '../db/index.js';
import {
  chargesForPairs,
  dirtyPairCount,
  dropPairs,
  loadPairs,
  markAllPairs,
  markClockPairs,
  nextDirtyPairs,
  priceKey,
  salesForPairs,
  usageForPairs,
  syncChargeFacts,
  syncChargeSales,
  syncPriceBook,
  type ChargeRow,
  type Pair,
  type SaleRow,
} from './chargeIndex.js';
import {
  compileLifecycle,
  rebuildPaymentEvents,
  reportUnknownEventTypes,
  CUSTOMER_EVENT_UPSERT,
  type CleanEvent,
  type SubRow,
} from './events.js';
import { buildReviewEvents } from '../appstore/events.js';
import { matchReviewsToShops } from '../appstore/match.js';
import { syncTransactionDaily } from './rollup.js';
import { syncStockDaily } from './stockRollup.js';

/**
 * Write-time normalization (spec 1.5). The Partner API hands back a stream of
 * lifecycle events and a stream of money; neither is queryable as "state at a
 * date". This module collapses both into derived tables whose columns are
 * already normalized, so every read-time query is sums and date comparisons.
 *
 * ## The unit of a rebuild is a merchant, not a day
 *
 * These are not daily rollups and cannot be repaired like one. A subscription's
 * life, an install's span and a lifecycle timeline are *reconstructions*: they
 * come out of walking one merchant's events in order, and a row that arrives
 * late can change the reconstruction from that point forward rather than only at
 * its own date. So the unit that can be invalidated is an `(app_id, shop_id)`
 * pair, and a pass rebuilds the pairs that are dirty and leaves the rest alone.
 *
 * ## What makes a pair dirty, and why the set is sufficient
 *
 * Every input to the reconstruction is one of these, and each is marked at the
 * moment it moves:
 *
 *  1. **An app event for the pair.** The ingest marks `(app_id, shop_id)` on
 *     every row it writes, insert and correction alike.
 *  2. **A settled sale against one of the pair's charges.** The ingest marks the
 *     charge; `syncChargeSales` turns that into the pair that holds it.
 *  3. **A charge changing hands.** `syncChargeFacts` marks the pair a charge
 *     came from as well as the one it went to.
 *  4. **The price book moving.** This is the one input that is not local to a
 *     merchant — `resolveInterval` reads a cadence learned from the app's other
 *     shops — so `syncPriceBook` compares the book against the stored one and
 *     marks every pair holding a charge at a price point whose answer changed.
 *  5. **The clock.** `now` enters the derivation in exactly two places, and both
 *     ask whether a charge's `billing_on` has arrived; a charge that crossed it
 *     since the last pass converts with nothing about it having changed, so
 *     `markClockPairs` sweeps that window.
 *
 * Nothing else is read. `firstPaidAt`, the sibling charges, the final uninstall
 * and the plan-change window are all computed from the pair's own rows, which is
 * what makes (1)-(3) enough for them; (4) and (5) exist precisely because they
 * are the two places where that is not true, and they are handled rather than
 * assumed away. There is no second round: the book is a function of
 * `charge_facts` and `charge_sales`, and rebuilding a pair writes neither, so
 * marking cannot cascade.
 *
 * ## Deletion
 *
 * A dirty pair is deleted from all three tables and rewritten from its rows, so
 * a merchant whose history comes back shorter loses the intervals it no longer
 * has. What that cannot see is a pair that vanishes from `app_events` outright —
 * nothing in the sync deletes raw rows, so it can only happen from a deliberate
 * purge, and `--full` is the answer to it.
 *
 * ## First run and recovery
 *
 * `derive_dirty_pairs` is the durable work list. A pair's mark is deleted in the
 * same transaction that rewrites the pair, so a pass killed half way leaves
 * exactly the merchants it did not reach still claimed. A database that has
 * never derived under this scheme has no clock watermark, which reads as "rebuild
 * everything" — the same answer `rebuild` and `sync --full` ask for outright.
 */

/**
 * Transactions recorded before this date carry no chargeId, so a subscription
 * that activated earlier cannot be matched to its first payment. Those fall
 * back to their activation date as the MRR gate.
 */
const CHARGE_ID_AVAILABLE_FROM = '2020-09-01T00:00:00.000Z';

const MS_PER_DAY = 86_400_000;

/**
 * Where the derivation records the wall clock it last ran under.
 *
 * In `sync_state` because that is what `sync_state` is for, and because a
 * missing value has to survive as "never run" through anything that clears the
 * derived tables. It is written only after a pass has drained its work list, so
 * a pass that dies re-sweeps the same clock window rather than skipping it.
 */
const DERIVE_CLOCK_KEY = 'derive:clock';

/**
 * Merchants rebuilt per statement, and per write transaction.
 *
 * The unit of work is bounded so this can never again be the thing that OOMs the
 * sync worker — the failure this codebase has already had once, from a derived
 * table that compiled its whole output into a single array before writing it.
 * A slice holds one chunk of merchants' charges, events and compiled rows, which
 * is a few megabytes at any population.
 */
const PAIR_CHUNK = 500;

/**
 * Partner transactions carry the date they were *recorded* into a payout batch,
 * not the date the merchant was charged, and payouts run twice a month. A final
 * sale landing days after a cancellation is therefore normal settlement lag, not
 * evidence the subscription is still alive. Only billing beyond this window
 * proves a charge outlived an event.
 */
const SETTLEMENT_LAG_DAYS = 21;

/**
 * How a cancel is paired with the activation that replaces it (spec §4.a/§4.b).
 *
 * Shopify performs a plan change as one operation: it cancels the old recurring
 * charge and activates the new one milliseconds apart, which is why the fold in
 * `events.ts` tie-breaks them at a shared instant. The pairing window exists to
 * absorb that gap and nothing else.
 *
 * It used to be `PLAN_CHANGE_WINDOW_DAYS`, two days wide and measured with
 * `Math.abs`, and that is far too generous to mean "the same operation". Any
 * merchant who cancelled and signed up again inside a long weekend was paired
 * with themselves: their cancellation was written off as a tier move, so a real
 * loss and a real win-back both vanished from the numbers, and the fold read
 * their return as an upgrade. The spec is specific about the sizes, and about
 * the direction — an activation *before* a cancel cannot be replacing it.
 */
export const PLAN_CHANGE_WINDOW_SECONDS = 60;

/**
 * Spec §4.b. A charge whose own activation lands a moment *before* its own
 * cancel is the feed re-emitting itself out of order, not a subscription that
 * lived for four seconds. Same charge only; this is an ordering guard.
 */
const PLAN_CHANGE_REEMIT_SECONDS = 5;

/** Is `to` at or after `from`, and closer to it than `seconds`? */
function withinSeconds(from: string, to: string, seconds: number): boolean {
  const gap = (new Date(to).getTime() - new Date(from).getTime()) / 1000;
  return gap >= 0 && gap < seconds;
}
const INSTALL_TYPES = ['RELATIONSHIP_INSTALLED', 'RELATIONSHIP_REACTIVATED'];
const UNINSTALL_TYPES = ['RELATIONSHIP_UNINSTALLED', 'RELATIONSHIP_DEACTIVATED'];

/**
 * Cadence -> monthly (spec 1.5). Shopify bills app subscriptions either every
 * 30 days or annually; the 30-day cycle passes through untouched by convention
 * rather than being scaled by 365/30.
 */
export function monthlyAmountFor(amount: number, billingInterval: string): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return billingInterval === 'ANNUAL' ? amount / 12 : amount;
}

/**
 * A billing gap this wide can only be an annual cycle. Shopify's other cadence
 * is 30 days, so nothing monthly is ever billed this far out; the tolerance
 * below 365 absorbs the date-vs-timestamp rounding described at `cycleDays`.
 */
const ANNUAL_GAP_DAYS = 360;

/**
 * When each app+shop relationship first paid, across every charge it has held.
 *
 * Keyed on the relationship rather than the charge because a plan change starts
 * a *new* charge: asking "has this charge been paid for" would answer no for
 * every upgrade, while the question that matters is whether the merchant behind
 * it was already a paying customer.
 *
 * Settled sales only. A charge that has been billed but whose transaction is
 * still in flight looks unpaid here, which costs nothing: the callers fall back
 * to `billing_on`, and the next rebuild after the payout lands corrects it.
 */

/**
 * The first usage billed at or after an instant.
 *
 * "At or after" matters on a plan change: a shop that has been paying for usage
 * for months and moves onto a new charge has usage on both sides of the switch,
 * and only what follows the new charge's activation says anything about whether
 * *it* has been paid for.
 */
function usagePaidAfter(ledger: Map<string, string[]>, key: string, from: string): string | null {
  const list = ledger.get(key);
  if (!list) return null;
  return list.find((at) => at >= from) ?? null;
}

function buildFirstPaidAt(
  charges: ChargeRow[],
  salesByRef: Map<string, SaleRow>,
): Map<string, string> {
  const first = new Map<string, string>();
  for (const charge of charges) {
    const sale = salesByRef.get(charge.charge_ref);
    if (!sale) continue;
    const key = `${charge.app_id} ${charge.shop_id}`;
    const seen = first.get(key);
    if (seen === undefined || sale.first_sale_at < seen) first.set(key, sale.first_sale_at);
  }
  return first;
}

/**
 * The billing cadence of one charge, from the strongest evidence available.
 *
 * Precedence is deliberate — each step is only reached because the one above it
 * had nothing to say:
 *
 *   1. a settled sale, which *states* the interval;
 *   2. a billing date a year out, which no 30-day charge can have. This is what
 *      catches an app's first-ever annual customer, before the price book has
 *      seen one — but only for a charge billed at activation, since a fresh
 *      annual trial is billed at the trial end, days away, and is
 *      indistinguishable from a monthly trial;
 *   3. the price book (see `syncPriceBook`), the one input that reads across
 *      shops and therefore the one that has to be watched for change;
 *   4. the 30-day cadence, which is both Shopify's default and the commoner
 *      case by an order of magnitude.
 */
function resolveInterval(
  charge: ChargeRow,
  sale: SaleRow | undefined,
  book: Map<string, string>,
  planIntervals: Map<string, string>,
  annualPlanPattern: RegExp | null,
): string {
  if (sale?.billing_interval) return sale.billing_interval;

  const gap =
    charge.activated_at && charge.billing_on
      ? daysBetween(charge.activated_at, charge.billing_on)
      : null;
  if (gap !== null && gap >= ANNUAL_GAP_DAYS) return 'ANNUAL';

  /**
   * Both tests above are evidence; this one is the plan's own name, and it only
   * gets a say where the evidence is silent. That is the zero-priced plan: no
   * subscription sale to carry an interval, and a `billing_on` that marks the
   * end of a free window rather than a year of service. Without this such a
   * plan reads as 30-day whatever it is called, and a year of revenue collected
   * through one usage charge is booked as a single month of run rate.
   */
  // What the partner set for the plan on the settings page, where the evidence
  // above is silent — the same gap the name pattern fills, filled by someone
  // who knows rather than by the name. See `usage/planIntervals.ts`.
  const setting = charge.plan_name
    ? planIntervals.get(`${charge.app_id} ${charge.plan_name}`)
    : undefined;
  if (setting) return setting;

  if (annualPlanPattern && charge.plan_name && annualPlanPattern.test(charge.plan_name)) {
    return 'ANNUAL';
  }

  return book.get(priceKey(charge.app_id, charge.plan_name, charge.amount)) ?? 'EVERY_30_DAYS';
}

function daysBetween(from: string, to: string): number {
  return (new Date(to).getTime() - new Date(from).getTime()) / MS_PER_DAY;
}

/** One raw app event, as the per-merchant reconstructions read it. */
interface EventRow {
  app_id: string;
  shop_id: string;
  type: string;
  occurred_at: string;
  charge_id: string;
  charge_name: string | null;
  charge_amount: number | null;
  charge_currency: string | null;
  charge_test: number;
}

interface DerivedSubscription extends ChargeRow {
  billing_interval: string;
  monthly_amount: number;
  conversion_at: string | null;
  churn_at: string | null;
  churn_reason: string | null;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  trial_status: string;
  is_plan_change: number;
  paid_sale_count: number;
  first_sale_at: string | null;
  last_sale_at: string | null;
}

/**
 * The uninstall a shop has *not* come back from, per app+shop: the latest
 * uninstall with no later install or reactivation.
 *
 * Only this final uninstall may end a subscription. Merchants routinely
 * uninstall and reinstall while their charge keeps billing, so treating any
 * uninstall as churn silently kills long-running paying customers. A genuine
 * mid-history cancellation still arrives as its own
 * SUBSCRIPTION_CHARGE_CANCELED event and is handled below.
 *
 * Read straight from the events rather than from install_intervals, so an
 * uninstall whose matching install predates SYNC_START_DATE still counts.
 */
interface Ending {
  at: string;
  /**
   * Which event ended the relationship: `RELATIONSHIP_UNINSTALLED` or
   * `RELATIONSHIP_DEACTIVATED`. The two are different endings wearing the same
   * shape, and only the caller can tell them apart — see `frozenByDeactivation`.
   */
  type: string;
}

function finalUninstalls(events: EventRow[]): Map<string, Ending> {
  const lastUninstall = new Map<string, Ending>();
  const lastInstall = new Map<string, string>();
  for (const row of events) {
    if (row.shop_id === '') continue;
    const key = `${row.app_id} ${row.shop_id}`;
    if (UNINSTALL_TYPES.includes(row.type)) {
      const seen = lastUninstall.get(key);
      if (seen === undefined || row.occurred_at > seen.at) {
        lastUninstall.set(key, { at: row.occurred_at, type: row.type });
      } else if (row.occurred_at === seen.at && row.type === 'RELATIONSHIP_UNINSTALLED') {
        // An uninstall and a deactivation stamped at the same instant is the
        // merchant leaving, not the platform closing the shop around them.
        lastUninstall.set(key, { at: seen.at, type: row.type });
      }
    } else if (INSTALL_TYPES.includes(row.type)) {
      const seen = lastInstall.get(key);
      if (seen === undefined || row.occurred_at > seen) lastInstall.set(key, row.occurred_at);
    }
  }

  const final = new Map<string, Ending>();
  for (const [key, ending] of lastUninstall) {
    if (ending.at > (lastInstall.get(key) ?? '')) final.set(key, ending);
  }
  return final;
}

/**
 * The subscription index for one slice of merchants.
 *
 * Pure: everything it reads is in its arguments, which is what makes the claim
 * "a merchant is a rebuildable unit" checkable rather than asserted. The only
 * argument that is not the slice's own rows is `book`, and that is the whole
 * subject of `syncPriceBook`.
 */
function deriveSubscriptions(
  charges: ChargeRow[],
  salesByRef: Map<string, SaleRow>,
  events: EventRow[],
  book: Map<string, string>,
  /** Plan intervals set on the settings page, the other cross-shop input. */
  planIntervals: Map<string, string>,
  /**
   * When this slice's shops were billed for metered usage, oldest first.
   *
   * An argument like everything else this reads, for the reason in the comment
   * above: a usage-priced plan carries a recurring amount of zero and never
   * produces an `AppSubscriptionSale`, so it is the only payment signal those
   * merchants have — and building it here from the whole `transactions` table
   * would put a full scan inside a per-merchant pass.
   */
  usage: Map<string, string[]>,
  now: string,
): DerivedSubscription[] {
  const { reporting } = getConfig();
  const firstPaidAt = buildFirstPaidAt(charges, salesByRef);
  const finalUninstall = reporting.churnOnUninstall
    ? finalUninstalls(events)
    : new Map<string, Ending>();

  // Sibling charges per shop+app, so a charge can tell whether it continues an
  // existing relationship or starts a new one.
  const siblings = new Map<string, ChargeRow[]>();
  for (const charge of charges) {
    const key = `${charge.app_id} ${charge.shop_id}`;
    const list = siblings.get(key);
    if (list) list.push(charge);
    else siblings.set(key, [charge]);
  }

  const derived: DerivedSubscription[] = [];

  for (const charge of charges) {
    const sale = salesByRef.get(charge.charge_ref);
    const amount = charge.amount ?? 0;
    const billingInterval = resolveInterval(
      charge,
      sale,
      book,
      planIntervals,
      reporting.annualPlanPattern,
    );
    const activatedAt = charge.activated_at;

    // Churn: an explicit cancel, or the merchant walking away entirely.
    let churnAt = charge.canceled_at;
    let churnReason: string | null = churnAt ? 'canceled' : null;
    if (reporting.churnOnUninstall && activatedAt) {
      const gone = finalUninstall.get(`${charge.app_id} ${charge.shop_id}`);
      const goneAt = gone?.at;
      // Billing that continued past the uninstall means the charge outlived it
      // (the merchant reinstalled, or event ordering is noisy), so the uninstall
      // is not what ended this subscription.
      const outlivedByBilling = Boolean(
        sale && goneAt && daysBetween(goneAt, sale.last_sale_at) > SETTLEMENT_LAG_DAYS,
      );

      /**
       * A deactivation that Shopify answered by freezing the charge.
       *
       * These are two different endings wearing the same shape. An *uninstall*
       * is the merchant removing the app: the charge is cancelled and the
       * subscription is over. A *deactivation* is the shop itself going away —
       * paused, closed, or suspended — and Shopify does not cancel the charge
       * for it, it freezes it, usually within seconds. The spec is explicit
       * that the deactivation is account-level and moves no MRR on its own
       * (§3.1); the freeze is what moves it, and `subscription_frozen` already
       * carries exactly that, reversibly.
       *
       * Treating the deactivation as churn as well booked the same loss twice
       * over: the merchant was reported cancelled *and* frozen one second
       * apart, and a store that later reopens — as this one did in March —
       * had a churn on its record that it never earned.
       */
      const frozenByDeactivation = Boolean(
        gone?.type === 'RELATIONSHIP_DEACTIVATED' &&
          goneAt &&
          charge.frozen_at &&
          charge.frozen_at >= goneAt &&
          (!charge.unfrozen_at || charge.unfrozen_at < charge.frozen_at),
      );

      if (
        goneAt &&
        goneAt > activatedAt &&
        !outlivedByBilling &&
        !frozenByDeactivation &&
        (!churnAt || goneAt < churnAt)
      ) {
        churnAt = goneAt;
        // Spec §7.1 keeps store closure apart from product churn: a shop that
        // was deactivated never passed a verdict on the app, and lumping it in
        // with uninstalls is what makes a churn-reason breakdown misleading.
        churnReason =
          gone?.type === 'RELATIONSHIP_DEACTIVATED' ? 'deactivated' : 'uninstalled';
      }
    }

    /**
     * `billing_on` is the charge's *next* billing date, which means two very
     * different things and must not be read as "trial ends here":
     *
     *  - on a fresh trial it is the trial end, a part-cycle away;
     *  - on a charge that was billed at activation it is a full cycle away;
     *  - on a mid-cycle plan change it is whatever remained of the cycle the
     *    merchant already paid for.
     *
     * Only the first is a trial. The other two are paying customers, and
     * treating them as trials understates paying shops and MRR.
     */
    // `billing_on` is a calendar date at midnight while activation carries a
    // time of day, so a full cycle measures slightly short of its nominal
    // length. One day of tolerance absorbs that; real trials sit far below it.
    const cycleDays = (billingInterval === 'ANNUAL' ? 365 : 30) - 1;
    const billingGapDays =
      activatedAt && charge.billing_on ? daysBetween(activatedAt, charge.billing_on) : null;

    /**
     * A charge that replaces one which ended at the same moment continues an
     * existing relationship rather than starting a trial — *if* that
     * relationship was a paying one.
     *
     * The rule earns its keep on a mid-cycle upgrade: the merchant has already
     * paid for the cycle they are in, so the replacement charge is not a trial
     * however short its remaining `billing_on` gap looks. But a merchant who
     * switches plan while still *inside* a trial is continuing the trial, and
     * Shopify says so plainly — it carries the unused trial days onto the new
     * charge, so the replacement bills on the date the original trial would
     * have ended. Reading that as "paid at activation" books revenue from
     * someone who has not been charged a cent, and starts their trial-conversion
     * clock on the wrong day.
     *
     * So the shop has to have actually paid for this app before this charge
     * activated. Where it has not, `billing_on` decides, which is right in both
     * directions.
     */
    const paidSince = firstPaidAt.get(`${charge.app_id} ${charge.shop_id}`);

    /**
     * Had this shop paid for this app before this charge activated?
     *
     * The charge's own first sale does not count — that lands *after* its
     * activation — so this is true only of a merchant who was already a
     * customer, which is the one thing in the feed that tells a trial apart
     * from a billing anchor the merchant has already paid for.
     */
    const paidBefore = Boolean(activatedAt && paidSince && paidSince <= activatedAt);

    const continuesPaidRelationship = Boolean(
      activatedAt &&
        paidBefore &&
        (siblings.get(`${charge.app_id} ${charge.shop_id}`) ?? []).some(
          (other) =>
            other.charge_id !== charge.charge_id &&
            other.canceled_at !== null &&
            withinSeconds(other.canceled_at, activatedAt, PLAN_CHANGE_WINDOW_SECONDS),
        ),
    );

    /**
     * Whether this charge was billed the moment it activated.
     *
     * This is a fact about the past, and a later cancellation cannot change it.
     * The condition used to be gated on `!churnAt`, which retroactively unmade
     * the payment of anyone who paid up front and then left: `conversion_at`
     * went null, so a shop that really did pay never entered MRR at all, and
     * the trial ladder below fell through to its churn branch and invented a
     * trial they never had.
     */
    const billedAtActivation =
      Boolean(activatedAt) &&
      (continuesPaidRelationship || (billingGapDays !== null && billingGapDays >= cycleDays));

    // The MRR gate is the first real payment, not activation: a subscription in
    // trial is live but worth nothing.
    let conversionAt: string | null;
    if (amount <= 0) {
      conversionAt = activatedAt;
    } else if (sale) {
      conversionAt = sale.first_sale_at;
    } else if (activatedAt && activatedAt < CHARGE_ID_AVAILABLE_FROM) {
      conversionAt = activatedAt;
    } else if (billedAtActivation) {
      conversionAt = activatedAt;
    } else if (charge.billing_on && charge.billing_on <= now && !churnAt) {
      // The billing date passed with no cancellation, so the merchant was
      // charged; the transaction simply has not settled into the payout feed
      // yet. Without this, every shop that converted in the last couple of
      // weeks reads as unpaid. This is one of the two readings of the wall
      // clock that `markClockPairs` exists to re-sweep.
      conversionAt = charge.billing_on;
    } else {
      conversionAt = null;
    }

    /**
     * When this subscription was first paid for, whichever way it bills.
     *
     * A priced plan is paid through an `AppSubscriptionSale` on its own charge.
     * A usage-priced plan has a recurring amount of zero and is paid through
     * metered usage, so its first payment is the shop's first usage sale after
     * this charge activated. Both are the same fact — the merchant started
     * paying — and the trial inference below wants that fact, not the price.
     *
     * Gating the inference on `amount > 0` instead is what made every merchant
     * on a zero-priced plan invisible to it: no price, so no trial, so nothing
     * for "On trial" to count however long their free window ran.
     */
    const paidAt =
      sale?.first_sale_at ??
      (amount <= 0 && activatedAt
        ? usagePaidAfter(usage, `${charge.app_id} ${charge.shop_id}`, activatedAt)
        : null);

    /**
     * When a trial window would close. `billing_on` states it outright and is
     * preferred; without one, a settled payment that landed materially later
     * than activation is the only remaining sign the merchant was not charged
     * up front. The second is the weaker evidence — a payout batch lags the
     * charge by up to `SETTLEMENT_LAG_DAYS` — but it is all the history from
     * before `billing_on` was recorded has.
     *
     * The fallback reads `paidAt` rather than the subscription sale alone, so a
     * usage-priced plan — which raises no subscription sale ever — can still
     * date the close of its free window from the metered spend that ended it.
     */
    const trialEnd =
      charge.billing_on !== null
        ? billingGapDays !== null && billingGapDays > reporting.trialMinGapDays
          ? charge.billing_on
          : null
        : paidAt && activatedAt && daysBetween(activatedAt, paidAt) > reporting.trialMinGapDays
          ? paidAt
          : null;

    /**
     * Whether this charge ran a trial at all (spec 6.1).
     *
     * The spec derives trial state from a window already known to exist, and
     * only *then* lets an ending classify it. That order is the whole point: a
     * cancellation can say how a trial finished, never that there was one. The
     * ladder below used to ask the opposite question first — "did this charge
     * end before any payment settled?" — which is true of everyone who leaves
     * early, trial or not. So a returning merchant who paid up front and quit
     * two days later was recorded as a cancelled trial and announced as one,
     * while the payment they had actually made went unbooked.
     *
     * The default is therefore no trial, and a window has to be shown. Two
     * signals together show one, and neither carries alone:
     *
     *  - `billing_on` falls short of a full cycle, so Shopify is visibly
     *    *waiting* to charge rather than having charged already; and
     *  - the shop has not paid for this app before, because Shopify does not
     *    grant the same shop a second trial. A short gap on a returning
     *    customer is the remainder of a cycle they have already bought.
     *
     * The second is what `billing_on` cannot express on its own: a resubscribe
     * that inherits the previous charge's billing date is indistinguishable
     * from a fresh part-cycle trial by the gap alone.
     *
     * Note the absence of a price test. A trial is a free window, and a plan
     * billed entirely through metered usage runs one exactly like a priced plan
     * does — `trialEnd` above dates it either way. Requiring `amount > 0` here
     * is what hid every usage-priced merchant from the trial reports, which is
     * the one thing this must not go back to.
     */
    const trialWindow =
      activatedAt && !billedAtActivation && !paidBefore ? trialEnd : null;

    let trialStatus = 'none';
    let trialEndsAt: string | null = null;
    if (trialWindow && activatedAt) {
      if (paidAt) {
        if (daysBetween(activatedAt, paidAt) > reporting.trialMinGapDays) {
          trialStatus = 'converted';
          trialEndsAt = paidAt;
        }
      } else if (churnAt) {
        // Spec 6.1's `canceled_during` and `canceled_after` both land here.
        // Which one it was is read downstream, off `churn_at` against
        // `trial_ends_at` — a comparison that only means anything because the
        // window above was established without consulting the churn.
        trialStatus = 'canceled';
        trialEndsAt = trialWindow;
      } else if (trialWindow > now) {
        // The second reading of the wall clock. See `markClockPairs`.
        trialStatus = 'in_trial';
        trialEndsAt = trialWindow;
      } else if (amount > 0) {
        // Past its billing date with no cancellation: it converted, and the
        // transaction is still in flight (see SETTLEMENT_LAG_DAYS). No gap
        // re-check here — `trialWindow` is the window, so its existence is
        // already settled by the time this branch is reachable.
        trialStatus = 'converted';
        trialEndsAt = trialWindow;
      } else {
        /**
         * A usage-priced plan bills nothing when its free window closes, so the
         * reasoning above does not transfer: no charge was raised, and no
         * transaction is in flight. The merchant is simply live on a metered
         * plan and has not consumed yet — they may tomorrow, next quarter, or
         * never, and nothing forces the question.
         *
         * That is an outcome still open, not a conversion and not a loss, so it
         * is named rather than folded into either. `trial_conversion_rate`
         * divides converted by converted-plus-cancelled, so this sits outside
         * the ratio instead of quietly inflating the numerator — which is
         * exactly what calling it 'converted' would have done for every shop
         * that has never spent a cent.
         */
        trialStatus = 'awaiting_usage';
        trialEndsAt = trialWindow;
      }
    } else if (
      amount > 0 &&
      activatedAt &&
      !billedAtActivation &&
      !charge.billing_on &&
      !sale &&
      !churnAt
    ) {
      // Activated, never billed, never cancelled, and no billing date to go on:
      // a genuine data gap rather than a trial outcome.
      trialStatus = 'unknown';
    }

    /**
     * No free window means the merchant was paying from activation. The first
     * sale is only when that payment reached a payout batch — up to a couple of
     * weeks later — so gating on it held every no-trial charge out of MRR for
     * that long, and left MRR disagreeing with the movement ledger, which books
     * it at activation (`contributionAt` in `events.ts`). The sale still has to
     * exist: a no-trial charge nobody ever paid for stays out.
     */
    if (trialStatus === 'none' && conversionAt !== null && activatedAt && activatedAt < conversionAt) {
      conversionAt = activatedAt;
    }

    derived.push({
      ...charge,
      billing_interval: billingInterval,
      monthly_amount: monthlyAmountFor(amount, billingInterval),
      conversion_at: conversionAt,
      churn_at: churnAt,
      churn_reason: churnReason,
      trial_started_at: trialStatus === 'none' ? null : activatedAt,
      trial_ends_at: trialEndsAt,
      trial_status: trialStatus,
      is_plan_change: 0,
      paid_sale_count: sale?.paid_sale_count ?? 0,
      first_sale_at: sale?.first_sale_at ?? null,
      last_sale_at: sale?.last_sale_at ?? null,
    });
  }

  // A cancel immediately followed by a new charge on the same shop is an
  // upgrade or downgrade, not churn. Shopify models plan changes as a new
  // subscription, so without this every upgrade would read as a lost customer.
  //
  // Local to the merchant by construction — the window only ever looks at that
  // shop's own activations — which is why the whole pass can be sliced this way.
  const activationsByShop = new Map<string, string[]>();
  for (const row of derived) {
    if (!row.activated_at) continue;
    const key = `${row.app_id} ${row.shop_id}`;
    const list = activationsByShop.get(key);
    if (list) list.push(row.activated_at);
    else activationsByShop.set(key, [row.activated_at]);
  }

  for (const row of derived) {
    if (!row.churn_at) continue;
    const churnAt = row.churn_at;
    const key = `${row.app_id} ${row.shop_id}`;

    // §4.a: another charge on this install picked up where this one stopped.
    const replaced = (activationsByShop.get(key) ?? []).some(
      (at) => at !== row.activated_at && withinSeconds(churnAt, at, PLAN_CHANGE_WINDOW_SECONDS),
    );
    // §4.b: this charge's own activation arrived just ahead of its cancel.
    const reemitted = Boolean(
      row.activated_at && withinSeconds(row.activated_at, churnAt, PLAN_CHANGE_REEMIT_SECONDS),
    );

    if (replaced || reemitted) {
      row.is_plan_change = 1;
      row.churn_reason = 'plan_change';
    }
  }

  return derived;
}

interface Interval {
  app_id: string;
  shop_id: string;
  started_at: string;
  ended_at: string | null;
  /** Which of the two install types opened it. See the schema comment. */
  started_by: 'installed' | 'reactivated';
}

/**
 * Install spans for one slice of merchants, from that slice's events in order.
 *
 * The events arrive grouped by pair and ordered within it, which is what the
 * fold below assumes; a merchant's whole history is always present in the slice,
 * so an interval can never be split across two of them.
 */
function deriveIntervals(events: EventRow[]): Interval[] {
  const intervals: Interval[] = [];
  let open: Interval | null = null;
  let currentKey = '';

  for (const row of events) {
    if (row.shop_id === '') continue;
    if (!INSTALL_TYPES.includes(row.type) && !UNINSTALL_TYPES.includes(row.type)) continue;

    const key = `${row.app_id} ${row.shop_id}`;
    if (key !== currentKey) {
      if (open) intervals.push(open);
      open = null;
      currentKey = key;
    }

    if (INSTALL_TYPES.includes(row.type)) {
      // Repeat installs without an intervening uninstall keep the first start.
      if (!open) {
        open = {
          app_id: row.app_id,
          shop_id: row.shop_id,
          started_at: row.occurred_at,
          ended_at: null,
          started_by: row.type === 'RELATIONSHIP_REACTIVATED' ? 'reactivated' : 'installed',
        };
      } else if (row.type === 'RELATIONSHIP_INSTALLED' && open.started_by === 'reactivated') {
        // A real install landing inside an interval a reopening opened. The
        // interval keeps its start — the app has been live since the shop came
        // back — but it stops being attributed to the reopening, because a
        // merchant did choose the app and the funnel should see it.
        open.started_by = 'installed';
      }
    } else if (open) {
      open.ended_at = row.occurred_at;
      intervals.push(open);
      open = null;
    }
    // An uninstall with no open interval means the install predates
    // SYNC_START_DATE; there is no start to attribute, so it is dropped.
  }
  if (open) intervals.push(open);

  return intervals;
}

/**
 * The events of the loaded slice of merchants, grouped by pair and ordered
 * within it.
 *
 * Through the slice table rather than an `OR` chain so SQLite drives the read
 * from `idx_events_app_shop`, which puts a merchant's rows together and in time
 * order — the order both folds above are written against — without a sort. The
 * `CROSS JOIN` pins the slice as the outer loop for the reason `chargesForPairs`
 * records.
 */
function eventsForPairs(db: Db): EventRow[] {
  return db
    .prepare(
      `SELECT e.app_id, e.shop_id, e.type, e.occurred_at, e.charge_id, e.charge_name,
              e.charge_amount, e.charge_currency, e.charge_test
         FROM temp.derive_slice p
         CROSS JOIN app_events e ON e.app_id = p.app_id AND e.shop_id = p.shop_id
        ORDER BY p.app_id, p.shop_id, e.occurred_at`,
    )
    .all() as EventRow[];
}

/** The subscription columns, in one place, so writer and reader cannot drift. */
const SUBSCRIPTION_INSERT = `INSERT INTO subscriptions (
     charge_id, charge_ref, app_id, shop_id, plan_name, amount, currency,
     billing_interval, monthly_amount, is_test, accepted_at, activated_at,
     conversion_at, churn_at, churn_reason, frozen_at, unfrozen_at,
     trial_started_at, trial_ends_at, trial_status, is_plan_change,
     paid_sale_count, first_sale_at, last_sale_at
   ) VALUES (
     @charge_id, @charge_ref, @app_id, @shop_id, @plan_name, @amount, @currency,
     @billing_interval, @monthly_amount, @is_test, @accepted_at, @activated_at,
     @conversion_at, @churn_at, @churn_reason, @frozen_at, @unfrozen_at,
     @trial_started_at, @trial_ends_at, @trial_status, @is_plan_change,
     @paid_sale_count, @first_sale_at, @last_sale_at
   )`;

/**
 * The lifecycle event types this module owns.
 *
 * The per-merchant delete names them rather than saying "everything that is not
 * a payment", because `customer_events` is also where review events live — they
 * are written by a different builder, from a different source, and one of them
 * can be written outside a sync entirely. Deleting by exclusion would throw
 * those away on every pass and rely on the review builder to put them back.
 */
const LIFECYCLE_TYPES = [
  'installed',
  'reinstalled',
  'uninstalled',
  'deactivated',
  'reactivated',
  'subscribed',
  'resubscribed',
  'upgraded',
  'downgraded',
  'unsubscribed',
  'subscription_frozen',
  'subscription_unfrozen',
  'charge_abandoned',
  'trial_abandoned',
  'trial_started',
  'trial_converted',
  'trial_expired',
];

/**
 * Rebuild one slice of merchants, and drop their marks in the same transaction.
 *
 * Delete-then-insert rather than upsert, per merchant, for the reason the other
 * two rollups give: a rebuilt merchant is recomputed from its raw rows rather
 * than adjusted, so a correction applied twice lands where applying it once
 * lands, and a history that came back shorter loses the rows it no longer has.
 */
function rebuildPairs(
  db: Db,
  pairs: Pair[],
  book: Map<string, string>,
  planIntervals: Map<string, string>,
  now: string,
): Written {
  loadPairs(db, pairs);
  const charges = chargesForPairs(db);
  const salesByRef = salesForPairs(db);
  const events = eventsForPairs(db);
  const usage = usageForPairs(db);
  dropPairs(db);

  const subscriptions = deriveSubscriptions(
    charges,
    salesByRef,
    events,
    book,
    planIntervals,
    usage,
    now,
  );
  const intervals = deriveIntervals(events);

  /*
   * The lifecycle compiler reads the subscription index as the authority on
   * normalized money and on which cancels were plan changes, so it is handed the
   * rows this slice has just derived rather than reading them back — which also
   * makes the ordering dependency an argument instead of a comment.
   */
  const subRows: SubRow[] = subscriptions
    .filter((row) => row.is_test === 0 && row.shop_id !== '')
    .map((row) => ({
      charge_id: row.charge_id,
      app_id: row.app_id,
      shop_id: row.shop_id,
      plan_name: row.plan_name,
      currency: row.currency,
      billing_interval: row.billing_interval,
      monthly_amount: row.monthly_amount,
      activated_at: row.activated_at,
      conversion_at: row.conversion_at,
      churn_at: row.churn_at,
      churn_reason: row.churn_reason,
      trial_started_at: row.trial_started_at,
      trial_ends_at: row.trial_ends_at,
      trial_status: row.trial_status,
      is_plan_change: row.is_plan_change,
    }));

  const lifecycle: CleanEvent[] = compileLifecycle(
    subRows,
    events.filter((row) => row.shop_id !== '' && row.charge_test === 0),
  );

  const subscriptionInsert = db.prepare(SUBSCRIPTION_INSERT);
  const intervalInsert = db.prepare(
    `INSERT INTO install_intervals (app_id, shop_id, started_at, ended_at, started_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(app_id, shop_id, started_at) DO UPDATE SET
       ended_at = excluded.ended_at,
       started_by = excluded.started_by`,
  );
  const lifecycleInsert = db.prepare(CUSTOMER_EVENT_UPSERT);

  const deleteSubscriptions = db.prepare(
    'DELETE FROM subscriptions WHERE app_id = ? AND shop_id = ?',
  );
  const deleteIntervals = db.prepare(
    'DELETE FROM install_intervals WHERE app_id = ? AND shop_id = ?',
  );
  const deleteLifecycle = db.prepare(
    `DELETE FROM customer_events
      WHERE app_id = ? AND shop_id = ?
        AND type IN (${LIFECYCLE_TYPES.map(() => '?').join(',')})`,
  );
  const clearMark = db.prepare('DELETE FROM derive_dirty_pairs WHERE app_id = ? AND shop_id = ?');

  db.transaction(() => {
    for (const pair of pairs) {
      deleteSubscriptions.run(pair.app_id, pair.shop_id);
      deleteIntervals.run(pair.app_id, pair.shop_id);
      deleteLifecycle.run(pair.app_id, pair.shop_id, ...LIFECYCLE_TYPES);
    }

    for (const row of subscriptions) {
      subscriptionInsert.run({
        charge_id: row.charge_id,
        charge_ref: row.charge_ref,
        app_id: row.app_id,
        shop_id: row.shop_id,
        plan_name: row.plan_name,
        amount: row.amount ?? 0,
        currency: row.currency,
        billing_interval: row.billing_interval,
        monthly_amount: row.monthly_amount,
        is_test: row.is_test ? 1 : 0,
        accepted_at: row.accepted_at,
        activated_at: row.activated_at,
        conversion_at: row.conversion_at,
        churn_at: row.churn_at,
        churn_reason: row.churn_reason,
        frozen_at: row.frozen_at,
        unfrozen_at: row.unfrozen_at,
        trial_started_at: row.trial_started_at,
        trial_ends_at: row.trial_ends_at,
        trial_status: row.trial_status,
        is_plan_change: row.is_plan_change,
        paid_sale_count: row.paid_sale_count,
        first_sale_at: row.first_sale_at,
        last_sale_at: row.last_sale_at,
      });
    }

    for (const interval of intervals) {
      intervalInsert.run(
        interval.app_id,
        interval.shop_id,
        interval.started_at,
        interval.ended_at,
        interval.started_by,
      );
    }

    for (const row of lifecycle) lifecycleInsert.run(row);

    // Last, and inside the same transaction as the rows: this is the whole of
    // the recovery story. A crash before the commit leaves the merchants marked
    // and the next pass redoes them; a crash after it leaves them correct.
    for (const pair of pairs) clearMark.run(pair.app_id, pair.shop_id);
  })();

  return {
    subscriptions: subscriptions.length,
    installs: intervals.length,
    customerEvents: lifecycle.length,
  };
}

/** Rows written by a pass, per table. */
interface Written {
  subscriptions: number;
  installs: number;
  customerEvents: number;
}

export interface DeriveResult {
  /**
   * Rows *written*, not rows stored.
   *
   * The figure this used to report for `customerEvents` was neither: the
   * lifecycle rows it had just compiled plus the payment rows it had just
   * *recompiled*, and the second half moved with a rolling recheck window rather
   * than with the data — so three consecutive steady-state passes over an
   * unchanging table reported three different numbers. Now that the payment half
   * compiles only what the ingest marked, "written" is a stable measure of the
   * work a pass did: zero when nothing changed, and exactly what moved when
   * something did.
   *
   * What is *stored* is a `COUNT(*)` of a table with millions of rows, which is
   * seconds on a cold cache and belongs in `doctor` and `/api/status`, where it
   * already is, rather than in every sync.
   */
  subscriptions: number;
  installs: number;
  customerEvents: number;
  reviewEvents: number;
  transactionDays: number;
  stockDays: number;
  /** Merchants rebuilt by this pass. */
  pairs: number;
  /** True when every merchant was rebuilt rather than a dirty subset. */
  full: boolean;
}

export function rebuildDerivedTables(db: Db, options: { full?: boolean } = {}): DeriveResult {
  const now = new Date().toISOString();

  /*
   * The money rollup, first and cheapest.
   *
   * First because it is the one derived table that reads nothing but
   * `transactions` — it has no dependency on the subscription index or the
   * install intervals — and because the currency profile warmed at the end of
   * the sync reads it. Cheapest because it is incremental: an ordinary sync
   * marks the handful of days it ingested and recomputes those, so the cost
   * tracks what arrived rather than what is stored.
   */
  const rollup = syncTransactionDaily(db, { full: options.full ?? false });

  const clock = readSyncState(db, DERIVE_CLOCK_KEY).cursor;
  // No watermark means the derivation has never run under this scheme: there is
  // no "last pass" for the clock sweep to start from, and no reason to trust
  // that the marks describe everything that has moved. That is a full rebuild,
  // which is also what `rebuild` and `sync --full` ask for outright.
  const full = Boolean(options.full) || clock === null;

  syncChargeSales(db, { full });
  syncChargeFacts(db, { full });

  if (full) {
    /*
     * The watermark goes first, and it is not tidiness.
     *
     * A full rebuild empties the three tables before it refills them. A crash in
     * that window, with the previous pass's watermark still stored, would leave
     * the next pass reading "incremental, nothing marked" — and the tables empty
     * for good. Clearing it first means a crash anywhere inside a full rebuild
     * reads as "never run", which is another full rebuild.
     */
    writeSyncState(db, DERIVE_CLOCK_KEY, { cursor: null, syncedThrough: null });
    db.transaction(() => {
      db.prepare('DELETE FROM subscriptions').run();
      db.prepare('DELETE FROM install_intervals').run();
      db.prepare(
        `DELETE FROM customer_events WHERE type IN (${LIFECYCLE_TYPES.map(() => '?').join(',')})`,
      ).run(...LIFECYCLE_TYPES);
      db.prepare('DELETE FROM derive_dirty_pairs').run();
    })();
    markAllPairs(db);
  } else {
    markClockPairs(db, clock, now);
  }

  // After the facts and the sales, because it is computed from them, and before
  // the rebuild, because its verdict is one of the things that decides which
  // merchants the rebuild covers.
  const book = syncPriceBook(db);
  const planIntervals = loadPlanIntervals(db);

  const pairsPlanned = dirtyPairCount(db);
  const written: Written = { subscriptions: 0, installs: 0, customerEvents: 0 };

  for (;;) {
    const slice = nextDirtyPairs(db, PAIR_CHUNK);
    if (slice.length === 0) break;
    const sliceWrote = rebuildPairs(db, slice, book, planIntervals, now);
    written.subscriptions += sliceWrote.subscriptions;
    written.installs += sliceWrote.installs;
    written.customerEvents += sliceWrote.customerEvents;
  }

  /*
   * The payment half of `customer_events`, which is not a per-merchant
   * reconstruction at all: a payment event is a pure function of the one
   * transaction it was compiled from, so it is repaired per transaction and has
   * been since the chunking that stopped this process being OOM-killed.
   */
  written.customerEvents += rebuildPaymentEvents(db, options.full ?? false);
  // Once for the pass, not once per slice of merchants.
  reportUnknownEventTypes();

  // Reviews come last, and in this order for two reasons: the matcher searches
  // shops that installed the app, which `install_intervals` has only just
  // finished rebuilding, and the review events sit in the same table as the
  // lifecycle rows the rebuild above rewrote.
  matchReviewsToShops(db);
  const reviewEvents = buildReviewEvents(db);

  /*
   * The subscription-side snapshots, last, because they read all three of the
   * tables above and would otherwise snapshot a half-rebuilt population.
   *
   * It works out which days changed by comparing the sources against what it
   * saw on the previous sync, which is still the right shape here: the rebuild
   * knows which *merchants* it touched, and a snapshot needs to know which
   * *days*, which is a different question that only the rows can answer.
   */
  const stock = syncStockDaily(db, { full: options.full ?? false });

  // Only once the work list is empty. A pass that died leaves the old clock in
  // place, so the next one re-sweeps the same window rather than skipping over
  // charges that crossed their billing date while it was down.
  writeSyncState(db, DERIVE_CLOCK_KEY, { cursor: now, syncedThrough: now });

  // Usage revenue as MRR reads it, from everything rebuilt above. Whole rather
  // than per merchant: it is one query, and a credit can net against a charge
  // on either side of a slice boundary.
  refreshUsageRecognized(db);

  db.prepare('DELETE FROM metric_cache').run();

  return {
    ...written,
    reviewEvents,
    transactionDays: rollup.days,
    stockDays: stock.days,
    pairs: pairsPlanned,
    full,
  };
}
