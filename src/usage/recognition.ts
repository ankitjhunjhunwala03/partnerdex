import type { Db } from '../db/index.js';
import { appFilter, type Fragment } from '../metrics/predicate.js';

/**
 * Usage revenue as a monthly rate: which usage charges are recognized, at what
 * monthly amount, and for how long.
 *
 * Every MRR figure that includes usage reads the result, and working it out
 * means classifying every usage charge in the store — its plan, its name, the
 * credits netted against it — which took the better part of a second each
 * time. A dashboard page asks for it once per card, and after every sync
 * clears the metric cache, so it is worked out once instead and kept in
 * `usage_recognized_rows`: rebuilt at the end of every derive pass, and again
 * whenever a plan interval or a charge name's exception is changed on the
 * settings page, the only other inputs it has. The metrics read that table.
 */

/**
 * How long a *metered* usage payment is recognized for, and the divisor that
 * keeps it a monthly rate: a payment contributes `amount * 30 / N` for N days,
 * so every dollar is still counted as exactly one month of run rate.
 *
 * Thirty days is the obvious term and the wrong one. Most metered shops are not
 * billed once a cycle but whenever their balance crosses Shopify's billing
 * threshold — every ten to sixteen days on a busy shop — so a 30-day window
 * holds one of those bills on some days and two on others, and the shop's
 * contribution swings by up to 2x without its consumption changing at all.
 * Summed across the book that sawtooth was most of the day-to-day movement in
 * MRR. A 60-day term halves it; the price is that a genuinely new level of
 * spend takes one extra cycle to be read at its full weight.
 *
 * Only metered spend is averaged like this. A plan fee billed through usage is
 * a price, not consumption, and is recognized for the cycle it pays for — see
 * `FEE_CYCLE_DAYS`.
 */
export const USAGE_TERM_DAYS = 60;

/**
 * A plan whose recurring price is zero is paid through usage: each charge is
 * the plan's fee (or a top-up to a higher tier), not metered spend. It is
 * recognized at its full amount for the 30-day cycle it pays for — averaging a
 * price would read a new merchant's first fee at half and blur every tier
 * change across two cycles.
 *
 * The cycle ends at the shop's next fee rather than on the 30th day exactly,
 * when that fee lands within `FEE_SLACK_DAYS` of it. Shopify settles a cycle's
 * charge a little early or late, and a hard 30-day edge turned every late
 * charge into a day with no fee at all and every early one into a day with two.
 * A top-up raised mid-cycle runs its own 30 days, so the tier it reached keeps
 * reading until the next cycle's top-ups reach it again.
 */
const FEE_CYCLE_DAYS = 30;
const FEE_SLACK_DAYS = 5;

/**
 * How far from a credit to look for the usage charge it gives back: a month
 * either side. A credit against a fee billed twice comes *first* — Shopify
 * raises it straight away, and the charges it cancels only settle on the
 * merchant's next invoice, one to three weeks later. A refund comes *after*,
 * anywhere from the next day to the merchant's next invoice a month on. So a
 * credit is netted against the shop's nearest usage charge in that span and
 * recognized with that charge's term, which restates the past once a late
 * refund arrives. A credit with nothing billed in that span (a refund of a
 * subscription price, a goodwill payment) is a one-off: it stays in gross
 * earnings and out of MRR.
 */
const CREDIT_LOOKBACK_DAYS = 30;
const CREDIT_LOOKAHEAD_DAYS = 30;
/** How close together a shop's charges settle to count as one billing run. */
const CREDIT_RUN_DAYS = 1;

/**
 * Metered usage as a monthly rate, recognized across the term each payment
 * bought rather than summed inside a fixed window.
 *
 * Usage is billed in arrears and lumpy, so a single instant says nothing and
 * some window is unavoidable. `USAGE_TERM_DAYS` is the one for ordinary metered
 * consumption. It is wrong for a payment that bought a year: an annual amount
 * collected through one usage charge would land in the window whole, report
 * twelve months of revenue as one month of run rate, and then vanish, so
 * neither the spike nor the cliff is a rate anybody has.
 *
 * So each payment carries its own term, by what it paid for:
 *
 *   - **metered spend** on a plan that carries its own price is spread across
 *     `USAGE_TERM_DAYS`;
 *   - **a plan fee** — any charge on a zero-priced plan — is recognized in full
 *     for its cycle (`FEE_CYCLE_DAYS`);
 *   - **a year** paid through usage is recognized at a twelfth of itself for
 *     365 days — the same normalization `monthly_amount` applies to an annual
 *     subscription price, and for the same reason.
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
 *
 * The plan decides, and the partner sets a plan's interval on the settings
 * page (see `usage/planIntervals.ts`). A charge's own name can be marked as an
 * exception to its plan (see `usage/chargeTypes.ts`) — a year paid on a monthly
 * plan, metered spend on a fee plan, or the one kind the plan cannot express at
 * all, a one-off such as custom work, which is revenue but never recurring and
 * is left out altogether. A name nobody has marked follows its plan.
 *
 * Credits are netted in: each one offsets the usage charge nearest to it (see
 * `CREDIT_LOOKAHEAD_DAYS`), so a fee that was billed twice and credited once, or
 * billed and refunded, is counted as what the merchant actually paid.
 *
 * Recognition stops when the shop uninstalls. A shop that has left is not a
 * recurring rate, and without the cut its last bill stayed in MRR for the rest
 * of its term — as did the final bill Shopify settles *after* the uninstall,
 * which is revenue but never run rate, so it is not recognized at all. A pair
 * with no install history is left alone: absent data is not an uninstall.
 */
export function usageRecognitionSql(appIds: string[], prefix: string): Fragment {
  const apps = appFilter(appIds, 't.app_id', prefix);
  // The shop is on a plan paid through usage: its recurring price is zero, so
  // a usage charge is the plan's own fee rather than metered spend on top.
  const onFeePlan = `EXISTS (
                SELECT 1 FROM subscriptions s
                 WHERE s.app_id = t.app_id
                   AND s.shop_id = t.shop_id
                   AND s.is_test = 0
                   AND s.amount <= 0
                   -- A charge that was never activated is a request, not a plan.
                   AND s.activated_at IS NOT NULL
                   AND s.activated_at <= t.created_at
                   AND (s.churn_at IS NULL OR s.churn_at > t.created_at)
              )`;
  const onAnnualPlan = `EXISTS (
                SELECT 1 FROM subscriptions s
                 WHERE s.app_id = t.app_id
                   AND s.shop_id = t.shop_id
                   AND s.is_test = 0
                   -- The plan's interval as set on the settings page, read here
                   -- so a change counts at once rather than after the next sync
                   -- re-derives the subscription; otherwise as derived.
                   AND COALESCE(
                         (SELECT CASE pi.interval WHEN 'annual' THEN 'ANNUAL' ELSE 'EVERY_30_DAYS' END
                            FROM plan_intervals pi
                           WHERE pi.app_id = s.app_id AND pi.plan_name = s.plan_name),
                         s.billing_interval) = 'ANNUAL'
                   -- Paid through usage rather than through its own price.
                   AND s.amount <= 0
                   AND s.activated_at IS NOT NULL
                   AND s.activated_at <= t.created_at
                   AND (s.churn_at IS NULL OR s.churn_at > t.created_at)
              )`;
  // The end of the install the charge landed in: null while it is still open,
  // and at or before the charge itself when the charge settled after it.
  const installEnd = `(
                SELECT i.ended_at FROM install_intervals i
                 WHERE i.app_id = t.app_id
                   AND i.shop_id = t.shop_id
                   AND i.started_at <= t.created_at
                 ORDER BY i.started_at DESC
                 LIMIT 1
              )`;
  // What the partner said a charge of this name is (see
  // `usage/chargeTypes.ts`), or null for a charge whose name is not on file.
  const namedKind = (alias: string) => `(
                SELECT ct.kind FROM usage_charge_names nm
                  JOIN usage_charge_types ct
                    ON ct.app_id = nm.app_id AND ct.name_key = nm.name_key
                 WHERE nm.app_id = ${alias}.app_id AND nm.charge_ref = ${alias}.charge_ref
              )`;
  // Rebuilt in the canonical ISO shape the rest of the store uses, so the
  // half-open comparisons below stay lexical. SQLite's own `datetime()` would
  // hand back "YYYY-MM-DD HH:MM:SS", which sorts nowhere near it.
  const termFrom = (days: number) =>
    `strftime('%Y-%m-%dT%H:%M:%fZ', usage_terms.created_at, '+${days} day')`;

  const creditApps = appFilter(appIds, 'c.app_id', `${prefix}c`);
  const near = (column: string, days: number) =>
    `strftime('%Y-%m-%dT%H:%M:%fZ', ${column}, '${days >= 0 ? '+' : ''}${days} day')`;
  // Usage charges of the credit's own shop, within the matching window of it.
  const chargesNear = (select: string) => `(
                SELECT ${select} FROM transactions u
                 WHERE u.type = 'AppUsageSale'
                   AND u.app_id = c.app_id
                   AND u.shop_id = c.shop_id
                   AND u.created_at >= ${near('c.created_at', -CREDIT_LOOKBACK_DAYS)}
                   AND u.created_at <= ${near('c.created_at', CREDIT_LOOKAHEAD_DAYS)}`;

  return {
    sql: `credit_matched AS (
         -- Each credit and the billing run it offsets: the shop's nearest usage
         -- charge within the window, before or after it.
         SELECT id, app_id, shop_id, credit_at, amount,
                CASE WHEN after_at IS NULL THEN before_at
                     WHEN before_at IS NULL THEN after_at
                     WHEN julianday(credit_at) - julianday(before_at)
                          <= julianday(after_at) - julianday(credit_at) THEN before_at
                     ELSE after_at END AS run_at
         FROM (
           SELECT c.id AS id,
                  c.app_id AS app_id,
                  c.shop_id AS shop_id,
                  c.created_at AS credit_at,
                  -c.gross_amount AS amount,
                  ${chargesNear('MAX(u.created_at)')} AND u.created_at <= c.created_at) AS before_at,
                  ${chargesNear('MIN(u.created_at)')} AND u.created_at > c.created_at) AS after_at
           FROM transactions c
           WHERE c.type = 'AppSaleCredit'
             AND c.shop_id <> ''
             AND c.gross_amount < 0
             ${creditApps.sql ? `AND ${creditApps.sql}` : ''}
         )
         WHERE before_at IS NOT NULL OR after_at IS NOT NULL
       ),
       credit_picked AS (
         -- Of the charges in that billing run — the shop's charges within a day
         -- of it, since a run settles over seconds or minutes — the one closest
         -- to the credit in amount: a credit is almost always one charge given
         -- back, and when a fee and a one-off were billed together it is the
         -- amount that says which. The pick is packed into one sortable string
         -- (distance, then the charge's timestamp and id) because this SQLite
         -- cannot ORDER BY an outer column inside a subquery.
         SELECT m.*,
                (SELECT MIN(printf('%020.4f|%s|%s', ABS(u.gross_amount - m.amount), u.created_at, u.charge_ref))
                   FROM transactions u
                  WHERE u.type = 'AppUsageSale'
                    AND u.app_id = m.app_id
                    AND u.shop_id = m.shop_id
                    AND u.created_at >= ${near('m.run_at', -CREDIT_RUN_DAYS)}
                    AND u.created_at <= ${near('m.run_at', CREDIT_RUN_DAYS)}) AS pick
         FROM credit_matched m
       ),
       credit_anchored AS (
         SELECT id, app_id, shop_id, credit_at, amount,
                substr(pick, 22, instr(substr(pick, 22), '|') - 1) AS run_at,
                substr(substr(pick, 22), instr(substr(pick, 22), '|') + 1) AS charge_ref
         FROM credit_picked
       ),
       credit_keyed AS MATERIALIZED (
         -- How the matched charge counts: following its plan, or the exception
         -- its name is marked with. A credit only offsets charges that count
         -- the same way, whatever their exact wording.
         SELECT a.*, COALESCE(${namedKind('a')}, 'plan') AS grp
         FROM credit_anchored a
       ),
       credit_rows AS (
         -- Never more than the shop was billed in the match window for charges
         -- that count the same way as the matched one, net of the
         -- credits already matched to the same, so a credit cannot take a shop
         -- below zero or cancel a fee on account of a one-off billed beside it.
         SELECT k.app_id, k.shop_id, k.charge_ref, k.run_at AS created_at,
                MAX(0, MIN(k.amount,
                  (SELECT COALESCE(SUM(u.gross_amount), 0) FROM transactions u
                    WHERE u.type = 'AppUsageSale'
                      AND u.app_id = k.app_id
                      AND u.shop_id = k.shop_id
                      AND u.created_at >= ${near('k.credit_at', -CREDIT_LOOKBACK_DAYS)}
                      AND u.created_at <= ${near('k.credit_at', CREDIT_LOOKAHEAD_DAYS)}
                      AND COALESCE(${namedKind('u')}, 'plan') = k.grp)
                  - (SELECT COALESCE(SUM(e.amount), 0) FROM credit_keyed e
                      WHERE e.app_id = k.app_id
                        AND e.shop_id = k.shop_id
                        -- Any earlier credit that could have matched the same charges.
                        AND e.credit_at >= ${near('k.credit_at', -(CREDIT_LOOKBACK_DAYS + CREDIT_LOOKAHEAD_DAYS))}
                        AND e.grp = k.grp
                        AND (e.credit_at < k.credit_at
                             OR (e.credit_at = k.credit_at AND e.id < k.id))))) AS amount
         FROM credit_keyed k
       ),
       usage_charges AS (
         SELECT t.app_id AS app_id,
                t.shop_id AS shop_id,
                t.charge_ref AS charge_ref,
                t.created_at AS created_at,
                t.gross_amount AS gross_amount
         FROM transactions t
         WHERE t.type = 'AppUsageSale'
         ${apps.sql ? `AND ${apps.sql}` : ''}
         UNION ALL
         -- A credit takes the date, and the charge id, of the charge it
         -- offsets, so it inherits that charge's kind and term and cancels it
         -- for exactly as long.
         SELECT app_id, shop_id, charge_ref, created_at, -amount
         FROM credit_rows
         WHERE amount > 0
       ),
       usage_terms AS MATERIALIZED (
         SELECT t.app_id AS app_id,
                t.shop_id AS shop_id,
                t.created_at AS created_at,
                -- An exception marked on the charge's name, else the plan the
                -- shop was on ('plan', or no name on file, falls through).
                CASE ${namedKind('t')}
                     WHEN 'annual' THEN 'annual'
                     WHEN 'monthly' THEN 'fee'
                     WHEN 'metered' THEN 'metered'
                     WHEN 'one_off' THEN 'one_off'
                     ELSE CASE WHEN ${onAnnualPlan} THEN 'annual'
                               WHEN ${onFeePlan} THEN 'fee'
                               ELSE 'metered' END
                END AS kind,
                t.gross_amount AS gross,
                ${installEnd} AS install_end
         FROM usage_charges t
       ),
       usage_classified AS (
         SELECT app_id,
                shop_id,
                created_at,
                install_end,
                CASE kind WHEN 'annual' THEN gross / 12.0
                          WHEN 'fee' THEN gross
                          ELSE gross * 30.0 / ${USAGE_TERM_DAYS}
                END AS monthly_amount,
                CASE kind WHEN 'annual' THEN ${termFrom(365)}
                          WHEN 'fee' THEN COALESCE(
                            (SELECT MIN(n.created_at) FROM transactions n
                              WHERE n.type = 'AppUsageSale'
                                AND n.app_id = usage_terms.app_id
                                AND n.shop_id = usage_terms.shop_id
                                AND n.created_at >= ${termFrom(FEE_CYCLE_DAYS - FEE_SLACK_DAYS)}
                                AND n.created_at <= ${termFrom(FEE_CYCLE_DAYS + FEE_SLACK_DAYS)}
                                -- Only a fee hands over a fee's cycle: one following
                                -- its plan, or one marked as a monthly fee.
                                AND COALESCE(${namedKind('n')}, 'plan') IN ('plan', 'monthly')),
                            ${termFrom(FEE_CYCLE_DAYS)})
                          ELSE ${termFrom(USAGE_TERM_DAYS)}
                END AS term_end
         FROM usage_terms
         -- A one-off is revenue, never run rate.
         WHERE kind <> 'one_off'
       ),
       usage_recognized AS MATERIALIZED (
         SELECT app_id,
                shop_id,
                created_at,
                monthly_amount,
                CASE WHEN install_end IS NOT NULL AND install_end < term_end
                     THEN install_end ELSE term_end END AS through
         FROM usage_classified
       )`,
    params: { ...apps.params, ...creditApps.params },
  };
}

/**
 * Rebuilds `usage_recognized_rows` from the store. Everything it reads is
 * either derived (and so rebuilt just before this in a derive pass) or set on
 * the settings page (whose setters call this), so the table is never staler
 * than the inputs it was computed from.
 */
export function refreshUsageRecognized(db: Db): number {
  const recognition = usageRecognitionSql([], 'rr');
  const run = db.transaction(() => {
    db.prepare('DELETE FROM usage_recognized_rows').run();
    return db
      .prepare(
        `INSERT INTO usage_recognized_rows (app_id, shop_id, created_at, monthly_amount, through)
         WITH ${recognition.sql}
         SELECT app_id, shop_id, created_at, monthly_amount, through
         FROM usage_recognized
         WHERE through > created_at`,
      )
      .run(recognition.params).changes;
  });
  return run();
}
