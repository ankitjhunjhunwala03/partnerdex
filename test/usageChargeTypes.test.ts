import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { getDb } from '../src/db/index.js';
import { runMetric } from '../src/metrics/registry.js';
import { runSync } from '../src/sync/index.js';
import {
  listUsageChargeTypes,
  nameKey,
  recordUsageChargeNames,
  setUsageChargeKind,
  suggestKind,
} from '../src/usage/chargeTypes.js';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../src/db/migrate.js';
import { rebuildDerivedTables } from '../src/sync/derive.js';
import { listPlans, setPlanInterval } from '../src/usage/planIntervals.js';
import { refreshUsageRecognized } from '../src/usage/recognition.js';
import { APP_ID, resetEnvironment, seed, seedCredits, seedUsageSales } from './helpers.js';

const NOW = new Date('2024-07-01T00:00:00.000Z');

/** A usage-only MRR read, one point per day over the given span. */
const daily = (start: string, end: string) =>
  runMetric(
    'mrr',
    { start, end, interval: 'day', includeSubscriptions: 'false', includeUsage: 'true' },
    { now: NOW },
  );
const valuesOf = (response: ReturnType<typeof daily>) => [
  ...new Set(response.timeSeries.map((point) => Math.round(point.value * 100) / 100)),
];

/** A shop on a zero-priced plan named monthly, the case the plan cannot read. */
const monthlyFeePlan = () =>
  seed([
    {
      chargeRef: '1',
      shopId: '10',
      planName: 'Custom - Starter (Monthly)',
      amount: 0,
      activatedAt: '2024-01-01T00:00:00Z',
    },
  ]);

/**
 * `seedUsageSales` numbers its usage records from 0, so the name of the charge
 * at position `index` is recorded against charge ref `index`.
 */
const nameCharges = (names: string[]) => {
  recordUsageChargeNames(
    getDb(),
    APP_ID,
    names.map((name, index) => ({
      chargeRef: String(index),
      shopId: '10',
      name,
      occurredAt: '2024-05-10T00:00:00.000Z',
    })),
  );
  // What the next derive pass would do with the names the sync just stored.
  refreshUsageRecognized(getDb());
};

describe('usage charge names', () => {
  beforeEach(() => resetEnvironment());

  it('groups names that differ only by an order number', () => {
    assert.equal(nameKey('Annual STARTER overage for #3586883'), 'Annual STARTER overage for #');
    assert.equal(
      nameKey('Annual STARTER overage for #3586883'),
      nameKey('Annual STARTER overage for #12'),
    );
    assert.equal(nameKey('  Monthly   BASIC base fee '), 'Monthly BASIC base fee');
  });

  it('suggests a kind from the wording an app actually uses', () => {
    const cases: Array<[string, string]> = [
      ['Monthly BASIC base fee', 'monthly'],
      ['Automatic monthly upgrade to Pro', 'monthly'],
      ['Annual STARTER base fee', 'annual'],
      ['Annual STARTER overage for #3586883', 'metered'],
      ['Usage charge for orders generated via AIOD Discounts.', 'metered'],
      ['Custom development of BXGY and Free Gift discounts logic', 'one_off'],
      ['Adjustment for change to Basic (annual)', 'one_off'],
      ['Something nobody has seen before', 'metered'],
    ];
    for (const [name, kind] of cases) assert.equal(suggestKind(name), kind, name);
  });

  it('files a new name as following its plan, and keeps a setting made by hand', () => {
    monthlyFeePlan();
    seedUsageSales([{ shopId: '10', at: '2024-05-10T00:00:00Z', gross: 39.99 }]);
    nameCharges(['Annual STARTER base fee']);
    let [type] = listUsageChargeTypes(getDb(), [APP_ID]);
    assert.equal(type?.kind, 'plan', 'the wording is a suggestion, not a setting');
    assert.equal(type?.suggestedKind, 'annual');
    assert.equal(type?.source, 'default');

    setUsageChargeKind(getDb(), APP_ID, 'Annual STARTER base fee', 'metered');
    nameCharges(['Annual STARTER base fee']);
    [type] = listUsageChargeTypes(getDb(), [APP_ID]);
    assert.equal(type?.kind, 'metered');
    assert.equal(type?.source, 'manual');
    assert.equal(type?.charges, 1);
    assert.equal(type?.total, 39.99);
  });

  it('flags a name for review only where its wording and its plan disagree', () => {
    monthlyFeePlan();
    seedUsageSales([
      { shopId: '10', at: '2024-05-10T00:00:00Z', gross: 39.99 },
      { shopId: '10', at: '2024-05-11T00:00:00Z', gross: 359.91 },
    ]);
    nameCharges(['Monthly STARTER base fee', 'Annual STARTER base fee']);

    const types = Object.fromEntries(
      listUsageChargeTypes(getDb(), [APP_ID]).map((type) => [type.key, type]),
    );
    assert.equal(types['Monthly STARTER base fee']?.needsReview, false, 'plan and wording agree');
    assert.deepEqual(types['Monthly STARTER base fee']?.planReads, { monthly: 1 });
    assert.equal(types['Annual STARTER base fee']?.needsReview, true, 'a year on a monthly plan');
    assert.deepEqual(types['Annual STARTER base fee']?.planReads, { monthly: 1 });
    assert.deepEqual(types['Annual STARTER base fee']?.plans, [
      { planName: 'Custom - Starter (Monthly)', countsAs: 'monthly', charges: 1 },
    ], 'the plan it follows, by name');

    setUsageChargeKind(getDb(), APP_ID, 'Annual STARTER base fee', 'annual');
    const [annual] = listUsageChargeTypes(getDb(), [APP_ID]).filter(
      (type) => type.key === 'Annual STARTER base fee',
    );
    assert.equal(annual?.needsReview, false, 'settled once someone has set it');
  });

  it('refuses a kind that does not exist, and a name that is not on file', () => {
    monthlyFeePlan();
    seedUsageSales([{ shopId: '10', at: '2024-05-10T00:00:00Z', gross: 39.99 }]);
    nameCharges(['Monthly STARTER base fee']);
    assert.throws(
      () => setUsageChargeKind(getDb(), APP_ID, 'Monthly STARTER base fee', 'weekly'),
      /must be one of/,
    );
    assert.throws(() => setUsageChargeKind(getDb(), APP_ID, 'No such charge', 'monthly'), /No usage charge/);
  });
});

describe('plan intervals', () => {
  beforeEach(() => resetEnvironment());

  it('lists plans with the interval each is read as, and why', () => {
    resetEnvironment({ ANNUAL_PLAN_PATTERN: 'yearly' });
    seed([
      { chargeRef: '1', shopId: '10', planName: 'Custom - Starter (Monthly)', amount: 0, activatedAt: '2024-01-01T00:00:00Z' },
      { chargeRef: '2', shopId: '11', planName: 'Custom - Starter (Yearly)', amount: 0, activatedAt: '2024-01-01T00:00:00Z' },
      { chargeRef: '3', shopId: '12', planName: 'PLUS', amount: 40, activatedAt: '2024-01-01T00:00:00Z', firstSaleAt: '2024-01-01T00:00:00Z' },
    ]);
    const plans = Object.fromEntries(listPlans(getDb(), [APP_ID]).map((plan) => [plan.planName, plan]));
    assert.equal(plans['Custom - Starter (Monthly)']?.interval, 'monthly');
    assert.equal(plans['Custom - Starter (Monthly)']?.basis, 'default');
    assert.equal(plans['Custom - Starter (Yearly)']?.interval, 'annual');
    assert.equal(plans['Custom - Starter (Yearly)']?.basis, 'name');
    assert.equal(plans.PLUS?.basis, 'shopify');
  });

  it('reads a plan set to yearly as yearly at once, and after a rebuild everywhere', () => {
    monthlyFeePlan();
    seedUsageSales([{ shopId: '10', at: '2024-02-10T00:00:00Z', gross: 1200 }]);
    assert.deepEqual(valuesOf(daily('2024-02-10', '2024-03-09')), [1200], 'a month, by default');

    setPlanInterval(getDb(), APP_ID, 'Custom - Starter (Monthly)', 'annual');
    assert.deepEqual(valuesOf(daily('2024-02-10', '2024-06-30')), [100], 'a year, straight away');

    rebuildDerivedTables(getDb());
    const row = getDb().prepare('SELECT billing_interval AS i FROM subscriptions').get() as { i: string };
    assert.equal(row.i, 'ANNUAL', 'and the subscription itself, once re-derived');

    setPlanInterval(getDb(), APP_ID, 'Custom - Starter (Monthly)', 'default');
    rebuildDerivedTables(getDb());
    assert.deepEqual(valuesOf(daily('2024-02-10', '2024-03-09')), [1200], 'back to the default');
  });

  it('refuses to set a priced plan, which Shopify states for itself', () => {
    seed([{ chargeRef: '3', shopId: '12', planName: 'PLUS', amount: 40, activatedAt: '2024-01-01T00:00:00Z', firstSaleAt: '2024-01-01T00:00:00Z' }]);
    assert.throws(() => setPlanInterval(getDb(), APP_ID, 'PLUS', 'annual'), /carries a price/);
    assert.throws(() => setPlanInterval(getDb(), APP_ID, 'Nope', 'annual'), /No plan named/);
  });
});

describe('MRR with charge name exceptions', () => {
  beforeEach(() => resetEnvironment());

  it('follows the plan for a name nobody has marked, whatever its wording', () => {
    monthlyFeePlan();
    seedUsageSales([{ shopId: '10', at: '2024-02-10T00:00:00Z', gross: 1200 }]);
    nameCharges(['Annual STARTER base fee']);

    assert.deepEqual(valuesOf(daily('2024-02-10', '2024-03-09')), [1200], 'the monthly plan decides');
  });

  it('reads a year from a name marked yearly, on a plan that says monthly', () => {
    monthlyFeePlan();
    seedUsageSales([{ shopId: '10', at: '2024-02-10T00:00:00Z', gross: 1200 }]);
    nameCharges(['Annual STARTER base fee']);
    setUsageChargeKind(getDb(), APP_ID, 'Annual STARTER base fee', 'annual');

    assert.deepEqual(valuesOf(daily('2024-02-10', '2024-06-30')), [100], 'a twelfth, every day');
  });

  it('leaves a one-off out of MRR, and does not let a credit cross into the fee', () => {
    monthlyFeePlan();
    seedUsageSales([
      { shopId: '10', at: '2024-05-10T00:00:00Z', gross: 39.99 },
      { shopId: '10', at: '2024-05-10T00:00:00Z', gross: 500 },
    ]);
    nameCharges(['Monthly STARTER base fee', 'Custom development of discount logic']);
    setUsageChargeKind(getDb(), APP_ID, 'Custom development of discount logic', 'one_off');
    seedCredits([{ shopId: '10', at: '2024-05-12T00:00:00Z', amount: 500 }]);

    assert.deepEqual(valuesOf(daily('2024-05-10', '2024-06-07')), [39.99], 'the fee, whole');
  });

  it('never takes a fee below zero with a credit larger than it', () => {
    monthlyFeePlan();
    seedUsageSales([
      { shopId: '10', at: '2024-05-10T00:00:00Z', gross: 39.99 },
      { shopId: '10', at: '2024-05-10T00:00:00Z', gross: 500 },
    ]);
    nameCharges(['Monthly STARTER base fee', 'Custom development of discount logic']);
    setUsageChargeKind(getDb(), APP_ID, 'Custom development of discount logic', 'one_off');
    seedCredits([{ shopId: '10', at: '2024-05-12T00:00:00Z', amount: 100 }]);

    const values = valuesOf(daily('2024-05-10', '2024-06-07'));
    assert.ok(values.every((value) => value >= 0 && value <= 39.99), `got ${values.join(', ')}`);
  });

  it('averages metered spend on a fee plan over 60 days when the name is marked so', () => {
    monthlyFeePlan();
    seedUsageSales([{ shopId: '10', at: '2024-05-10T00:00:00Z', gross: 120 }]);
    nameCharges(['Annual STARTER overage for #3586883']);
    setUsageChargeKind(getDb(), APP_ID, 'Annual STARTER overage for #', 'metered');

    assert.deepEqual(valuesOf(daily('2024-05-10', '2024-07-07')), [60]);
  });

  it('keeps the plan-based reading for a charge with no name on file', () => {
    monthlyFeePlan();
    seedUsageSales([{ shopId: '10', at: '2024-05-10T00:00:00Z', gross: 39.99 }]);

    assert.deepEqual(valuesOf(daily('2024-05-10', '2024-06-07')), [39.99]);
  });
});

describe('the first cut of usage charge types', () => {
  it('becomes following the plan, keeping its reading as the suggestion', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE usage_charge_types (
      app_id TEXT NOT NULL, name_key TEXT NOT NULL, example_name TEXT NOT NULL,
      kind TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'suggested',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (app_id, name_key)) WITHOUT ROWID;
      CREATE TABLE metric_cache (key TEXT PRIMARY KEY);
      INSERT INTO usage_charge_types VALUES
        ('1', 'Annual STARTER base fee', 'Annual STARTER base fee', 'annual', 'suggested', 't', 't'),
        ('1', 'Custom work', 'Custom work', 'one_off', 'manual', 't', 't');`);
    MIGRATIONS.find((migration) => migration.version === 7)!.up(db);
    assert.deepEqual(
      db.prepare('SELECT name_key, kind, suggested_kind, source FROM usage_charge_types ORDER BY name_key').all(),
      [
        { name_key: 'Annual STARTER base fee', kind: 'plan', suggested_kind: 'annual', source: 'default' },
        { name_key: 'Custom work', kind: 'one_off', suggested_kind: 'one_off', source: 'manual' },
      ],
    );
    db.close();
  });
});

describe('usage charge name sync', () => {
  beforeEach(() => resetEnvironment({ BIGQUERY_ENABLED: 'false' }));

  it('backfills the names from the Partner API, each following its plan', async () => {
    const originalFetch = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(String(init.body)) as { query: string };
      const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
      if (query.includes('PartnerdexApp(')) {
        return ok({ app: { id: `gid://partners/App/${APP_ID}`, name: 'Test App', apiKey: 'k' } });
      }
      if (query.includes('PartnerdexUsageChargeEvents')) {
        asked.push('usage');
        const edge = (id: string, name: string, test = false) => ({
          cursor: id,
          node: {
            type: 'USAGE_CHARGE_APPLIED',
            occurredAt: '2024-05-10T00:00:00Z',
            shop: { id: 'gid://shopify/Shop/10', name: 'Shop 10', myshopifyDomain: 's10.myshopify.com' },
            charge: { id: `gid://shopify/AppUsageRecord/${id}`, name, test },
          },
        });
        return ok({
          app: {
            id: `gid://partners/App/${APP_ID}`,
            events: {
              pageInfo: { hasNextPage: false },
              edges: [
                edge('1190236455280', 'Annual STARTER base fee'),
                edge('77', 'Monthly BASIC base fee'),
                edge('78', 'Monthly BASIC base fee'),
                edge('99', 'Test charge', true),
              ],
            },
          },
        });
      }
      if (query.includes('PartnerdexTransactions')) {
        return ok({ transactions: { pageInfo: { hasNextPage: false }, edges: [] } });
      }
      return ok({ app: { events: { pageInfo: { hasNextPage: false }, edges: [] } } });
    }) as unknown as typeof fetch;

    try {
      await runSync();
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(asked, ['usage']);
    const names = getDb()
      .prepare('SELECT charge_ref, name FROM usage_charge_names ORDER BY charge_ref')
      .all();
    assert.deepEqual(names, [
      { charge_ref: '1190236455280', name: 'Annual STARTER base fee' },
      { charge_ref: '77', name: 'Monthly BASIC base fee' },
      { charge_ref: '78', name: 'Monthly BASIC base fee' },
    ], 'test charges are not recorded');
    const kinds = getDb()
      .prepare('SELECT name_key, kind, source FROM usage_charge_types ORDER BY name_key')
      .all();
    assert.deepEqual(kinds, [
      { name_key: 'Annual STARTER base fee', kind: 'plan', source: 'default' },
      { name_key: 'Monthly BASIC base fee', kind: 'plan', source: 'default' },
    ]);
  });
});
