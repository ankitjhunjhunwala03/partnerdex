import { refreshUsageRecognized } from './recognition.js';
import { getConfig } from '../config.js';
import type { Db } from '../db/index.js';

/**
 * The billing interval of each plan, as the partner sets it.
 *
 * A priced plan needs no help: Shopify states its interval on every payment.
 * A zero-priced plan billed through usage charges states nothing — no sale
 * carries an interval, and its first billing date is the end of a free window
 * rather than a year out — so its interval is a fact only the partner has. It
 * used to be read from the plan's name alone (`ANNUAL_PLAN_PATTERN`). That is
 * still the default for a plan nobody has set; this is where it is set.
 *
 * A setting takes effect twice over: MRR follows it straight away, and the
 * merchants on the plan are marked for the next sync to re-derive, so every
 * other report that reads a subscription's interval agrees with it too.
 */

export const PLAN_INTERVALS = ['monthly', 'annual'] as const;
export type PlanInterval = (typeof PLAN_INTERVALS)[number];

export class PlanIntervalError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'PlanIntervalError';
    this.status = status;
  }
}

export interface PlanRow {
  appId: string;
  appName: string | null;
  planName: string;
  /** A plan with a recurring price: Shopify states its interval, so it is not set here. */
  priced: boolean;
  price: number;
  shops: number;
  /** Whether any usage charge has been billed on it: a plan that bills nothing has no interval to set. */
  billed: boolean;
  /** What the plan is read as now. */
  interval: PlanInterval;
  /** What it is read as with nothing set: the name pattern's verdict, else monthly. */
  defaultInterval: PlanInterval;
  /**
   * Why: 'shopify' for a priced plan, 'setting' for one set on the page,
   * 'name' where ANNUAL_PLAN_PATTERN matched, and 'default' for the rest.
   */
  basis: 'shopify' | 'setting' | 'name' | 'default';
}

/** Every plan the apps in scope have had a live charge on, largest first. */
export function listPlans(db: Db, appIds: string[]): PlanRow[] {
  const pattern = getConfig().reporting.annualPlanPattern;
  const rows = db
    .prepare(
      `SELECT s.app_id AS appId,
              a.name AS appName,
              s.plan_name AS planName,
              MAX(s.amount) AS price,
              COUNT(DISTINCT s.shop_id) AS shops,
              SUM(s.billing_interval = 'ANNUAL') AS annualCharges,
              COUNT(*) AS charges,
              pi.interval AS setting,
              MAX(EXISTS (
                SELECT 1 FROM transactions t
                 WHERE t.type = 'AppUsageSale' AND t.app_id = s.app_id AND t.shop_id = s.shop_id
                   AND t.created_at >= s.activated_at
                   AND (s.churn_at IS NULL OR t.created_at < s.churn_at))) AS billed
       FROM subscriptions s
       LEFT JOIN apps a ON a.id = s.app_id
       LEFT JOIN plan_intervals pi ON pi.app_id = s.app_id AND pi.plan_name = s.plan_name
       WHERE s.is_test = 0 AND s.plan_name IS NOT NULL AND s.activated_at IS NOT NULL
       GROUP BY s.app_id, s.plan_name
       ORDER BY shops DESC, s.plan_name`,
    )
    .all() as Array<{
    appId: string;
    appName: string | null;
    planName: string;
    price: number;
    shops: number;
    annualCharges: number;
    charges: number;
    setting: PlanInterval | null;
    billed: number;
  }>;

  const scoped = new Set(appIds);
  return rows
    .filter((row) => appIds.length === 0 || scoped.has(row.appId))
    .map((row) => {
      const priced = row.price > 0;
      const defaultInterval: PlanInterval = pattern?.test(row.planName) ? 'annual' : 'monthly';
      let interval: PlanInterval;
      let basis: PlanRow['basis'];
      if (priced) {
        interval = row.annualCharges * 2 > row.charges ? 'annual' : 'monthly';
        basis = 'shopify';
      } else if (row.setting) {
        interval = row.setting;
        basis = 'setting';
      } else if (defaultInterval === 'annual') {
        interval = 'annual';
        basis = 'name';
      } else {
        interval = 'monthly';
        basis = 'default';
      }
      return {
        appId: row.appId,
        appName: row.appName,
        planName: row.planName,
        priced,
        price: row.price,
        shops: row.shops,
        billed: row.billed === 1,
        interval,
        defaultInterval,
        basis,
      };
    });
}

/**
 * Sets a zero-priced plan's interval, or 'default' to go back to what the name
 * says. A priced plan is refused: Shopify's own statement of its interval is
 * evidence, and a setting that overruled it would only be a way to be wrong.
 */
export function setPlanInterval(
  db: Db,
  appId: string,
  planName: string,
  interval: string,
): { appId: string; planName: string; interval: PlanInterval | 'default' } {
  if (interval !== 'default' && !(PLAN_INTERVALS as readonly string[]).includes(interval)) {
    throw new PlanIntervalError(
      `"interval" must be one of ${[...PLAN_INTERVALS, 'default'].join(', ')}, got "${interval}".`,
    );
  }
  const plan = db
    .prepare(
      `SELECT MAX(amount) AS price, COUNT(*) AS charges FROM subscriptions
        WHERE app_id = ? AND plan_name = ? AND is_test = 0`,
    )
    .get(appId, planName) as { price: number | null; charges: number };
  if (plan.charges === 0) {
    throw new PlanIntervalError(`No plan named "${planName}" for app ${appId}.`, 404);
  }
  if ((plan.price ?? 0) > 0) {
    throw new PlanIntervalError(
      `"${planName}" carries a price, so Shopify states its interval; it cannot be set here.`,
    );
  }

  const write = db.transaction(() => {
    if (interval === 'default') {
      db.prepare('DELETE FROM plan_intervals WHERE app_id = ? AND plan_name = ?').run(appId, planName);
    } else {
      db.prepare(
        `INSERT INTO plan_intervals (app_id, plan_name, interval, updated_at)
         VALUES (@appId, @planName, @interval, @now)
         ON CONFLICT(app_id, plan_name) DO UPDATE SET
           interval = excluded.interval, updated_at = excluded.updated_at`,
      ).run({ appId, planName, interval, now: new Date().toISOString() });
    }
    // Every merchant who has held the plan, for the next sync to re-derive.
    db.prepare(
      `INSERT OR IGNORE INTO derive_dirty_pairs (app_id, shop_id)
       SELECT DISTINCT app_id, shop_id FROM subscriptions WHERE app_id = ? AND plan_name = ?`,
    ).run(appId, planName);
    refreshUsageRecognized(db);
    db.prepare('DELETE FROM metric_cache').run();
  });
  write();
  return { appId, planName, interval: interval as PlanInterval | 'default' };
}

/** The settings as the derive step reads them: "app plan" → Shopify's interval name. */
export function loadPlanIntervals(db: Db): Map<string, string> {
  const rows = db
    .prepare('SELECT app_id, plan_name, interval FROM plan_intervals')
    .all() as Array<{ app_id: string; plan_name: string; interval: PlanInterval }>;
  return new Map(
    rows.map((row) => [
      `${row.app_id} ${row.plan_name}`,
      row.interval === 'annual' ? 'ANNUAL' : 'EVERY_30_DAYS',
    ]),
  );
}
