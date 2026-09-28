import { refreshUsageRecognized } from './recognition.js';
import type { Db } from '../db/index.js';

/**
 * Exceptions to the plan, by usage charge name.
 *
 * The plan a shop is on decides what its usage charges are: a zero-priced plan
 * is paid through them, monthly or yearly as the plan says (see
 * `planIntervals.ts`), and on a priced plan they are metered spend on top. That
 * is right for almost every charge and wrong for a few the plan cannot express:
 * a year paid on a plan named monthly, or a one-off invoice for custom work,
 * which is revenue but never recurring. The app says which is which in the
 * name it gives every usage charge, and the Partner API hands that name back
 * on the USAGE_CHARGE_APPLIED event.
 *
 * So every name defaults to following its plan, and the settings page is where
 * the partner marks the exceptions. Names are grouped, not taken one by one: a
 * name with an order number in it would otherwise be a new row every time. The
 * wording's own reading is kept as a suggestion to offer, and never applied on
 * its own.
 */

/** What a charge can be told to count as. */
export const USAGE_CHARGE_KINDS = ['monthly', 'annual', 'metered', 'one_off'] as const;
export type UsageChargeKind = (typeof USAGE_CHARGE_KINDS)[number];
/** A charge name's setting: an exception, or 'plan' to follow the plan. */
export const USAGE_CHARGE_SETTINGS = ['plan', ...USAGE_CHARGE_KINDS] as const;
export type UsageChargeSetting = (typeof USAGE_CHARGE_SETTINGS)[number];

export class UsageChargeTypeError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'UsageChargeTypeError';
    this.status = status;
  }
}

/** The name with every run of digits replaced by "#", so an order number groups. */
export function nameKey(name: string): string {
  return name.replace(/#?\d+(?:[.,]\d+)*/g, '#').replace(/\s+/g, ' ').trim();
}

/**
 * A reading of a charge from its name, offered on the settings page.
 *
 * The order matters, because names mix words: "Annual STARTER overage" is
 * consumption on top of a yearly plan, not the year itself, and "Adjustment
 * for change to Basic (annual)" is a one-off correction, not a year either.
 * Anything the wording does not settle reads as metered.
 */
export function suggestKind(name: string): UsageChargeKind {
  if (/\b(adjustment|custom|development|setup|set-up|one[- ]?time|onboarding|refund)\b/i.test(name)) {
    return 'one_off';
  }
  if (/\b(overage|usage|orders?|consum\w*|metered)\b/i.test(name)) return 'metered';
  if (/\b(annual|annually|yearly|year)\b/i.test(name)) return 'annual';
  if (/\b(monthly|month|base fee|subscription|upgrade|plan)\b/i.test(name)) return 'monthly';
  return 'metered';
}

export interface UsageChargeNameNode {
  chargeRef: string;
  shopId: string;
  name: string;
  occurredAt: string;
}

/**
 * Stores the names of a page of usage charges, and files any group seen for
 * the first time as following its plan. A group already on file is never
 * touched here: a later charge's wording is not a reason to overrule what the
 * partner chose.
 */
export function recordUsageChargeNames(db: Db, appId: string, nodes: UsageChargeNameNode[]): number {
  const insertName = db.prepare(
    `INSERT INTO usage_charge_names (app_id, charge_ref, shop_id, name, name_key, occurred_at)
     VALUES (@appId, @chargeRef, @shopId, @name, @nameKey, @occurredAt)
     ON CONFLICT(app_id, charge_ref) DO UPDATE SET
       name = excluded.name,
       name_key = excluded.name_key,
       shop_id = excluded.shop_id,
       occurred_at = excluded.occurred_at`,
  );
  const insertType = db.prepare(
    `INSERT INTO usage_charge_types
       (app_id, name_key, example_name, kind, suggested_kind, source, created_at, updated_at)
     VALUES (@appId, @nameKey, @name, 'plan', @kind, 'default', @now, @now)
     ON CONFLICT(app_id, name_key) DO NOTHING`,
  );

  const run = db.transaction((batch: UsageChargeNameNode[]) => {
    const now = new Date().toISOString();
    let written = 0;
    for (const node of batch) {
      if (!node.chargeRef || !node.name) continue;
      const key = nameKey(node.name);
      insertName.run({ appId, ...node, nameKey: key });
      insertType.run({ appId, nameKey: key, name: node.name, kind: suggestKind(node.name), now });
      written += 1;
    }
    return written;
  });
  return run(nodes);
}

export interface UsageChargeType {
  appId: string;
  appName: string | null;
  key: string;
  exampleName: string;
  kind: UsageChargeSetting;
  /** What the wording reads as, to offer. */
  suggestedKind: UsageChargeKind;
  source: 'default' | 'manual';
  /** Usage charges carrying this name that are in the transactions feed. */
  charges: number;
  shops: number;
  total: number;
  lastSeen: string | null;
  /** How many of this name's charges their plan counts as each kind. */
  planReads: Partial<Record<UsageChargeKind, number>>;
  /**
   * The plans this name's charges were billed on — the plan the shop held when
   * each charge landed — and what that plan counts them as. Null for a charge
   * billed when the shop held no live plan.
   */
  plans: Array<{ planName: string | null; countsAs: UsageChargeKind; charges: number }>;
  /**
   * The wording reads as something the plan does not count at least one of
   * its charges as: the names worth a look. False once a name is set by hand.
   */
  needsReview: boolean;
}

/**
 * How the plan counts a usage charge, with no exception applied: the same rule
 * `usage/recognition.ts` falls back to, restated per charge so the page can say
 * where a name and its plan disagree. A zero-priced plan is a fee, yearly or
 * monthly as the plan is set or named; anything else is metered spend.
 */
const PLAN_READING = `CASE
      WHEN EXISTS (
        SELECT 1 FROM subscriptions s
         WHERE s.app_id = t.app_id AND s.shop_id = t.shop_id AND s.is_test = 0
           AND s.amount <= 0 AND s.activated_at IS NOT NULL
           AND s.activated_at <= t.created_at
           AND (s.churn_at IS NULL OR s.churn_at > t.created_at)
           AND COALESCE(
                 (SELECT CASE pi.interval WHEN 'annual' THEN 'ANNUAL' ELSE 'EVERY_30_DAYS' END
                    FROM plan_intervals pi
                   WHERE pi.app_id = s.app_id AND pi.plan_name = s.plan_name),
                 s.billing_interval) = 'ANNUAL') THEN 'annual'
      WHEN EXISTS (
        SELECT 1 FROM subscriptions s
         WHERE s.app_id = t.app_id AND s.shop_id = t.shop_id AND s.is_test = 0
           AND s.amount <= 0 AND s.activated_at IS NOT NULL
           AND s.activated_at <= t.created_at
           AND (s.churn_at IS NULL OR s.churn_at > t.created_at)) THEN 'monthly'
      ELSE 'metered' END`;

/**
 * The plan a shop held when a charge landed: a zero-priced one first, since
 * that is the plan a usage charge pays for, then the most recently activated.
 * Packed into one sortable string (price flag, activation, name) because this
 * SQLite cannot ORDER BY an outer column inside a subquery; the name starts
 * after the fixed-width prefix.
 */
const PLAN_AT_CHARGE = `substr((
      SELECT MAX(printf('%d|%s|%s', s.amount <= 0, s.activated_at, s.plan_name))
        FROM subscriptions s
       WHERE s.app_id = t.app_id AND s.shop_id = t.shop_id AND s.is_test = 0
         AND s.activated_at IS NOT NULL AND s.activated_at <= t.created_at
         AND (s.churn_at IS NULL OR s.churn_at > t.created_at)), 28)`;

/** Every kind of usage charge seen for the given apps, largest by money first. */
export function listUsageChargeTypes(db: Db, appIds: string[]): UsageChargeType[] {
  const reads = db
    .prepare(
      `SELECT n.app_id AS appId, n.name_key AS key,
              ${PLAN_AT_CHARGE} AS planName,
              ${PLAN_READING} AS reading,
              COUNT(*) AS charges
       FROM usage_charge_names n
       JOIN transactions t
         ON t.type = 'AppUsageSale' AND t.app_id = n.app_id AND t.charge_ref = n.charge_ref
       GROUP BY n.app_id, n.name_key, planName, reading
       ORDER BY charges DESC`,
    )
    .all() as Array<{
    appId: string;
    key: string;
    planName: string | null;
    reading: UsageChargeKind;
    charges: number;
  }>;
  const readsByName = new Map<string, Partial<Record<UsageChargeKind, number>>>();
  const plansByName = new Map<string, UsageChargeType['plans']>();
  for (const read of reads) {
    const id = `${read.appId} ${read.key}`;
    const entry = readsByName.get(id) ?? {};
    entry[read.reading] = (entry[read.reading] ?? 0) + read.charges;
    readsByName.set(id, entry);
    const plans = plansByName.get(id) ?? [];
    plans.push({ planName: read.planName || null, countsAs: read.reading, charges: read.charges });
    plansByName.set(id, plans);
  }

  const rows = db
    .prepare(
      `SELECT ct.app_id AS appId,
              a.name AS appName,
              ct.name_key AS key,
              ct.example_name AS exampleName,
              ct.kind AS kind,
              ct.suggested_kind AS suggestedKind,
              ct.source AS source,
              COUNT(t.id) AS charges,
              COUNT(DISTINCT t.shop_id) AS shops,
              COALESCE(ROUND(SUM(t.gross_amount), 2), 0) AS total,
              MAX(n.occurred_at) AS lastSeen
       FROM usage_charge_types ct
       LEFT JOIN apps a ON a.id = ct.app_id
       LEFT JOIN usage_charge_names n ON n.app_id = ct.app_id AND n.name_key = ct.name_key
       LEFT JOIN transactions t
         ON t.type = 'AppUsageSale' AND t.app_id = n.app_id AND t.charge_ref = n.charge_ref
       GROUP BY ct.app_id, ct.name_key
       ORDER BY total DESC, ct.name_key`,
    )
    .all() as Array<Omit<UsageChargeType, 'planReads' | 'plans' | 'needsReview'>>;
  const scoped = new Set(appIds);
  return rows
    .filter((row) => appIds.length === 0 || scoped.has(row.appId))
    .map((row) => {
      const planReads = readsByName.get(`${row.appId} ${row.key}`) ?? {};
      const needsReview =
        row.kind === 'plan' &&
        Object.entries(planReads).some(([reading, count]) => reading !== row.suggestedKind && (count ?? 0) > 0);
      const plans = plansByName.get(`${row.appId} ${row.key}`) ?? [];
      return { ...row, planReads, plans, needsReview };
    });
}

/**
 * Sets a charge name's exception, or 'plan' to take it away, and brings the
 * recognized usage MRR reads up to date with it.
 */
export function setUsageChargeKind(
  db: Db,
  appId: string,
  key: string,
  kind: string,
): { appId: string; key: string; kind: UsageChargeSetting; source: 'default' | 'manual' } {
  if (!(USAGE_CHARGE_SETTINGS as readonly string[]).includes(kind)) {
    throw new UsageChargeTypeError(
      `"kind" must be one of ${USAGE_CHARGE_SETTINGS.join(', ')}, got "${kind}".`,
    );
  }
  const source = kind === 'plan' ? 'default' : 'manual';
  const result = db
    .prepare(
      `UPDATE usage_charge_types
          SET kind = @kind, source = @source, updated_at = @now
        WHERE app_id = @appId AND name_key = @key`,
    )
    .run({ appId, key, kind, source, now: new Date().toISOString() });
  if (result.changes === 0) {
    throw new UsageChargeTypeError(`No usage charge named "${key}" for app ${appId}.`, 404);
  }
  refreshUsageRecognized(db);
  db.prepare('DELETE FROM metric_cache').run();
  return { appId, key, kind: kind as UsageChargeSetting, source };
}
