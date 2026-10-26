import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { getDb } from '../src/db/index.js';
import {
  acquisitionSummary,
  creditedTouch,
  resolveTouch,
  shopAcquisitions,
} from '../src/bigquery/acquisition.js';
import { funnelReport } from '../src/metrics/reports/funnel.js';
import { syncListingEvents } from '../src/bigquery/ingest.js';
import { useBigQueryConstructor } from '../src/bigquery/client.js';
import { saveAppSource, saveConnection } from '../src/bigquery/connection.js';
import { INSTALL_EVENT, LISTING_VIEW_EVENT } from '../src/bigquery/events.js';
import { APP_ID, resetEnvironment, seed, seedForApp } from './helpers.js';

/**
 * Source and medium per merchant, and the places it could quietly lie:
 *
 *   - crediting a visit to the browser's first-ever source instead of the
 *     session that carried it
 *   - letting a direct revisit erase the campaign that actually brought someone
 *   - crediting a visit that came after the install, or long before it
 *   - handing one app's installs to another in a shared GA4 property
 */

const KEY = JSON.stringify({
  type: 'service_account',
  project_id: 'demo',
  private_key_id: 'abcdef0123456789',
  private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----',
  client_email: 'partnerdex@demo.iam.gserviceaccount.com',
});

const NOW = new Date('2024-06-01T00:00:00Z');
const RANGE = { from: '2024-05-01T00:00:00.000Z', to: '2024-06-01T00:00:00.000Z' };

function visit(visitor: string, at: string, source: string | null, medium: string | null, campaign: string | null = null) {
  getDb()
    .prepare(
      `INSERT INTO listing_events (event_id, app_id, type, occurred_at, anonymous_id, source, medium, campaign)
       VALUES (?, ?, 'listing_view', ?, ?, ?, ?, ?)`,
    )
    .run(`${visitor}:${at}`, APP_ID, at, visitor, source, medium, campaign);
}

function install(visitor: string, shopId: string, at: string) {
  getDb()
    .prepare(
      `INSERT INTO listing_installs (event_id, app_id, shop_id, shop_domain, anonymous_id, installed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(`${visitor}:${shopId}:${at}`, APP_ID, shopId, `${shopId}.myshopify.com`, visitor, at);
}

beforeEach(() => {
  resetEnvironment();
});

describe('acquisition: which visit is credited', () => {
  it('takes the latest visit with a real source', () => {
    const touch = creditedTouch([
      { occurredAt: '2024-05-01T00:00:00Z', source: 'google', medium: 'organic', campaign: null },
      { occurredAt: '2024-05-03T00:00:00Z', source: 'newsletter', medium: 'email', campaign: 'may' },
    ]);
    assert.equal(touch?.source, 'newsletter');
  });

  it('does not let a direct revisit erase the campaign before it', () => {
    const touch = creditedTouch([
      { occurredAt: '2024-05-01T00:00:00Z', source: 'facebook', medium: 'cpc', campaign: 'spring' },
      { occurredAt: '2024-05-05T00:00:00Z', source: '(direct)', medium: '(none)', campaign: null },
      { occurredAt: '2024-05-06T00:00:00Z', source: null, medium: null, campaign: null },
    ]);
    assert.equal(touch?.source, 'facebook');
  });

  it('falls back to direct when that is all there is', () => {
    const touch = creditedTouch([
      { occurredAt: '2024-05-01T00:00:00Z', source: '(direct)', medium: '(none)', campaign: null },
    ]);
    assert.equal(touch?.source, '(direct)');
    assert.equal(creditedTouch([]), null);
  });
});

describe('acquisition: when GA4 has no source', () => {
  const at = '2024-05-01T00:00:00Z';
  const unknown = { occurredAt: at, source: '(not set)', medium: '(not set)', campaign: '(not set)' };

  it('reads an App Store search off the listing URL, with the search term as the campaign', () => {
    const touch = resolveTouch({
      ...unknown,
      pageLocation:
        'https://apps.shopify.com/app-one?search_id=x&surface_detail=+automatic+discount+&surface_intra_position=5&surface_type=search',
    });
    assert.deepEqual(
      { source: touch.source, medium: touch.medium, campaign: touch.campaign },
      { source: 'shopify app store', medium: 'search', campaign: 'automatic discount' },
    );
  });

  it('names autocomplete, which carries no surface_type', () => {
    const touch = resolveTouch({
      ...unknown,
      pageLocation: 'https://apps.shopify.com/app-one?st_source=autocomplete&surface_detail=autocomplete_apps',
    });
    assert.equal(touch.medium, 'autocomplete');
  });

  it('names the Shopify admin’s app search, which Shopify tags utm_source=shopify', () => {
    const touch = resolveTouch({
      occurredAt: at,
      source: 'shopify',
      medium: null,
      campaign: 'admin-search',
      pageLocation:
        'https://apps.shopify.com/app-one?st_campaign=admin-search&st_source=admin-web&utm_campaign=admin-search&utm_source=shopify',
    });
    assert.deepEqual([touch.source, touch.medium], ['shopify admin', 'search']);
  });

  it('calls a visit with no referrer and no parameters direct', () => {
    const plain = resolveTouch({ ...unknown, pageLocation: 'https://apps.shopify.com/app-one?locale=es' });
    assert.deepEqual([plain.source, plain.medium], ['(direct)', '(none)']);

    const tagged = resolveTouch({ ...unknown, pageLocation: 'https://apps.shopify.com/app-one?utm_content=x' });
    assert.equal(tagged.source, '(not set)', 'a tagged visit GA4 could not read is unknown, not direct');
  });

  it('falls back to the referrer, and leaves a real GA4 source alone', () => {
    const fromAdmin = resolveTouch({
      ...unknown,
      pageLocation: 'https://apps.shopify.com/app-one',
      pageReferrer: 'https://admin.shopify.com/',
    });
    assert.deepEqual([fromAdmin.source, fromAdmin.medium], ['admin.shopify.com', 'referral']);

    const tagged = resolveTouch({
      occurredAt: at,
      source: 'newsletter',
      medium: 'email',
      campaign: null,
      pageLocation: 'https://apps.shopify.com/app-one?surface_type=search',
    });
    assert.equal(tagged.source, 'newsletter');
  });

  it('lets a real source beat an unknown one that came later', () => {
    const touch = creditedTouch([
      { occurredAt: '2024-05-01T00:00:00Z', source: 'google', medium: 'organic', campaign: null },
      { occurredAt: '2024-05-02T00:00:00Z', source: '(not set)', medium: '(not set)', campaign: null },
    ]);
    assert.equal(touch?.source, 'google');
  });
});

describe('acquisition: joining visits to shops', () => {
  it('credits the shop with the source of the visit that led to its install', () => {
    visit('p1', '2024-05-10T09:00:00.000Z', 'admin-web', 'referral');
    visit('p1', '2024-05-12T09:00:00.000Z', 'newsletter', 'email', 'may');
    install('p1', '5001', '2024-05-12T09:05:00.000Z');

    const [row] = shopAcquisitions([APP_ID], RANGE);
    assert.equal(row.shopId, '5001');
    assert.equal(row.source, 'newsletter');
    assert.equal(row.medium, 'email');
    assert.equal(row.campaign, 'may');
    assert.equal(row.visitedAt, '2024-05-12T09:00:00.000Z');
  });

  it('ignores visits after the install and before the window', () => {
    visit('p1', '2024-03-01T00:00:00.000Z', 'old-campaign', 'cpc');
    install('p1', '5001', '2024-05-12T09:00:00.000Z');
    visit('p1', '2024-05-13T00:00:00.000Z', 'returning', 'email');

    const [row] = shopAcquisitions([APP_ID], RANGE);
    assert.equal(row.source, null, 'neither visit could have brought this merchant');
  });

  it('keeps an install with no joinable visit, so coverage stays visible', () => {
    install('p9', '5009', '2024-05-20T00:00:00.000Z');
    const rows = shopAcquisitions([APP_ID], RANGE);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, null);
  });

  it('credits a reinstalling shop from its first install in range', () => {
    visit('p1', '2024-05-02T00:00:00.000Z', 'google', 'cpc');
    install('p1', '5001', '2024-05-03T00:00:00.000Z');
    visit('p2', '2024-05-20T00:00:00.000Z', 'newsletter', 'email');
    install('p2', '5001', '2024-05-21T00:00:00.000Z');

    const rows = shopAcquisitions([APP_ID], RANGE);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'google');
  });
});

describe('acquisition: collecting from the GA4 export', () => {
  function fakeExport(rows: Array<Record<string, unknown>>, seen: Array<{ query: string; params: Record<string, unknown> }>) {
    useBigQueryConstructor(
      class {
        query(options: { query: string; params: Record<string, unknown> }) {
          seen.push(options);
          return Promise.resolve([seen.length === 1 ? rows : []]);
        }
      } as never,
    );
  }

  it('reads the session source rather than the browser’s first one, and stores installs', async () => {
    seedForApp(APP_ID, '1');
    saveConnection({ projectId: 'demo', credentials: KEY });
    saveAppSource(APP_ID, { dataset: 'analytics_111' });

    const micros = (iso: string) => String(Date.parse(iso) * 1000);
    const seen: Array<{ query: string; params: Record<string, unknown> }> = [];
    fakeExport(
      [
        {
          event_name: LISTING_VIEW_EVENT,
          user_pseudo_id: 'p1',
          event_timestamp: micros('2024-05-10T09:00:00Z'),
          source: 'newsletter',
          medium: 'email',
          campaign: 'may',
        },
        {
          event_name: INSTALL_EVENT,
          user_pseudo_id: 'p1',
          shop_id: '5001',
          shop_url: 'Acme.myshopify.com',
          event_timestamp: micros('2024-05-10T09:05:00Z'),
        },
      ],
      seen,
    );

    getDb()
      .prepare(`INSERT INTO metric_cache (key, payload, expires_at) VALUES ('funnel?stale', '{}', '2999-01-01')`)
      .run();
    await syncListingEvents(getDb(), [APP_ID], { now: NOW });
    useBigQueryConstructor(null);

    assert.ok(seen[0].query.includes('session_traffic_source_last_click'));
    assert.equal(seen[0].query.includes('traffic_source.source'), false);
    assert.ok((seen[0].params.eventNames as string[]).includes(INSTALL_EVENT));

    const [row] = shopAcquisitions([APP_ID], RANGE);
    assert.equal(row.shopDomain, 'acme.myshopify.com');
    assert.equal(row.source, 'newsletter');

    const cached = getDb().prepare(`SELECT COUNT(*) AS n FROM metric_cache WHERE key LIKE 'funnel%'`).get() as { n: number };
    assert.equal(cached.n, 0, 'a funnel cached before the rows landed must not outlive them');

    const views = getDb().prepare('SELECT COUNT(*) AS n FROM listing_events').get() as { n: number };
    assert.equal(views.n, 1, 'the install is not a listing event and must stay out of the funnel');
  });

  it('leaves installs out of a shared property when the app has no API key', async () => {
    resetEnvironment({ PARTNER_APP_IDS: `${APP_ID},222` });
    seedForApp(APP_ID, '1');
    seedForApp('222', '2', '20');
    getDb().exec(`UPDATE apps SET api_key = NULL`);
    saveConnection({ projectId: 'demo', credentials: KEY });
    saveAppSource(APP_ID, { dataset: 'shared_ga4', handle: 'app-one' });
    saveAppSource('222', { dataset: 'shared_ga4', handle: 'app-two', apiKey: 'key-two' });

    const seen: Array<{ query: string; params: Record<string, unknown> }> = [];
    useBigQueryConstructor(
      class {
        query(options: { query: string; params: Record<string, unknown> }) {
          seen.push(options);
          return Promise.resolve([[]]);
        }
      } as never,
    );
    await syncListingEvents(getDb(), [APP_ID, '222'], { now: NOW });
    useBigQueryConstructor(null);

    const byKey = seen.find((q) => q.params.apiKey === 'key-two');
    assert.ok(byKey, 'the app with a key reads its installs by that key');
    assert.ok((byKey.params.eventNames as string[]).includes(INSTALL_EVENT));

    const keyless = seen.find((q) => q.params.apiKey === undefined);
    assert.ok(keyless);
    assert.equal(
      (keyless.params.eventNames as string[]).includes(INSTALL_EVENT),
      false,
      'without a key, the other app’s merchants would be credited here',
    );
  });
});

describe('acquisition: by channel', () => {
  const MARCH = { from: '2024-03-01T00:00:00.000Z', to: '2024-04-01T00:00:00.000Z' };
  const LATER = new Date('2024-06-01T00:00:00Z');

  /** The Partner API's install, which every row of the summary starts from. */
  function partnerInstall(shopId: string, at: string) {
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO install_intervals (app_id, shop_id, started_at, started_by)
         VALUES (?, ?, ?, 'installed')`,
      )
      .run(APP_ID, shopId, at);
  }

  function click(visitor: string, at: string, source: string | null = null, medium: string | null = null) {
    getDb()
      .prepare(
        `INSERT INTO listing_events (event_id, app_id, type, occurred_at, anonymous_id, source, medium)
         VALUES (?, ?, 'add_app_click', ?, ?, ?, ?)`,
      )
      .run(`click:${visitor}:${at}`, APP_ID, at, visitor, source, medium);
  }

  function seedPaidShop() {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 50,
        activatedAt: '2024-03-04T00:00:00Z',
        firstSaleAt: '2024-03-13T00:00:00Z',
      },
    ]);
  }

  it('groups shops by source and medium, with what they went on to pay', () => {
    seedPaidShop();
    visit('p1', '2024-03-02T00:00:00.000Z', 'newsletter', 'email', 'march');
    install('p1', '10', '2024-03-03T00:00:00.000Z');
    partnerInstall('10', '2024-03-03T00:00:00.000Z');
    visit('p2', '2024-03-05T00:00:00.000Z', 'newsletter', 'email', 'march');
    install('p2', '20', '2024-03-05T01:00:00.000Z');
    partnerInstall('20', '2024-03-05T01:00:00.000Z');
    visit('p3', '2024-03-06T00:00:00.000Z', 'google', 'organic');
    install('p3', '30', '2024-03-06T01:00:00.000Z');
    partnerInstall('30', '2024-03-06T01:00:00.000Z');

    const summary = acquisitionSummary([APP_ID], { ...MARCH, now: LATER });
    const [first, second] = summary.channels;
    assert.deepEqual(
      { source: first.source, medium: first.medium, installs: first.installs, paying: first.paying, mrr: first.mrr },
      { source: 'newsletter', medium: 'email', installs: 2, paying: 1, mrr: 50 },
    );
    assert.deepEqual(first.campaigns, ['march']);
    assert.equal(second.source, 'google');
    assert.equal(second.paying, 0);
  });

  it('accounts for every Partner install, the unplaced ones in rows of their own', () => {
    visit('p1', '2024-03-02T00:00:00.000Z', 'google', 'organic');
    install('p1', '10', '2024-03-03T00:00:00.000Z');
    partnerInstall('10', '2024-03-03T00:00:00.000Z');
    // GA4 saw the install, but this browser never visited the listing.
    install('p2', '20', '2024-03-05T00:00:00.000Z');
    partnerInstall('20', '2024-03-05T00:00:00.000Z');
    // GA4 has no record of this one at all.
    partnerInstall('30', '2024-03-07T00:00:00.000Z');

    const summary = acquisitionSummary([APP_ID], { ...MARCH, now: LATER });
    assert.equal(summary.installs, 3);
    assert.equal(summary.recorded, 2);
    assert.equal(summary.traced, 1);
    assert.deepEqual(
      summary.channels.map((channel) => [channel.kind, channel.installs]),
      [
        ['traced', 1],
        ['no_visit', 1],
        ['not_recorded', 1],
      ],
    );
  });

  it('places an install by the one Add app click in the minute before it', () => {
    // GA4 never recorded this install, but a browser clicked Add app 12s before.
    visit('p9', '2024-03-10T11:50:00.000Z', 'newsletter', 'email');
    click('p9', '2024-03-10T11:59:48.000Z', 'newsletter', 'email');
    partnerInstall('90', '2024-03-10T12:00:00.000Z');

    const summary = acquisitionSummary([APP_ID], { ...MARCH, now: LATER });
    assert.equal(summary.traced, 1);
    assert.equal(summary.matchedBy.timing, 1);
    assert.equal(summary.channels[0]!.source, 'newsletter');
  });

  it('leaves an install unplaced when two browsers clicked in that minute', () => {
    click('a', '2024-03-10T11:59:30.000Z', 'google', 'organic');
    click('b', '2024-03-10T11:59:50.000Z', 'newsletter', 'email');
    partnerInstall('90', '2024-03-10T12:00:00.000Z');

    const summary = acquisitionSummary([APP_ID], { ...MARCH, now: LATER });
    assert.equal(summary.traced, 0, 'two candidates is a guess, not a match');
    assert.equal(summary.channels[0]!.kind, 'not_recorded');
  });

  it('does not lend a browser already tied to another shop', () => {
    click('p1', '2024-03-10T11:59:50.000Z', 'google', 'organic');
    install('p1', '10', '2024-03-10T11:59:58.000Z');
    partnerInstall('10', '2024-03-10T11:59:57.000Z');
    partnerInstall('20', '2024-03-10T12:00:00.000Z');

    const summary = acquisitionSummary([APP_ID], { ...MARCH, now: LATER });
    assert.equal(summary.traced, 1, 'shop 10 owns that click; shop 20 cannot have it too');
  });

  it('counts a shop paying through usage, and its usage MRR', () => {
    visit('p1', '2024-03-02T00:00:00.000Z', 'newsletter', 'email');
    install('p1', '10', '2024-03-03T00:00:00.000Z');
    partnerInstall('10', '2024-03-03T00:00:00.000Z');
    visit('p2', '2024-03-02T00:00:00.000Z', 'newsletter', 'email');
    install('p2', '20', '2024-03-03T00:00:00.000Z');
    partnerInstall('20', '2024-03-03T00:00:00.000Z');
    getDb()
      .prepare(
        `INSERT INTO usage_recognized_rows (app_id, shop_id, created_at, monthly_amount, through, kind)
         VALUES (?, '10', '2024-05-20T00:00:00.000Z', 30, '2024-06-19T00:00:00.000Z', 'fee')`,
      )
      .run(APP_ID);

    const [channel] = acquisitionSummary([APP_ID], { ...MARCH, now: LATER }).channels;
    assert.equal(channel.paying, 1, 'a zero-priced plan billed through usage is still a paying merchant');
    assert.equal(channel.mrr, 30);
  });

  it('is on the funnel only when BigQuery is connected, and sums to its installs', () => {
    seedPaidShop();
    const query = { period: 'custom', start: '2024-03-01', end: '2024-03-31', appIds: APP_ID, nocache: '1' };
    assert.equal(funnelReport(query).acquisition, null);

    saveConnection({ projectId: 'demo', credentials: KEY });
    visit('p1', '2024-03-02T00:00:00.000Z', 'newsletter', 'email');
    install('p1', '10', '2024-03-03T00:00:00.000Z');

    const report = funnelReport(query, { now: LATER });
    assert.ok(report.acquisition);
    assert.equal(report.acquisition.installs, report.totals.counts[2]);
    assert.equal(
      report.acquisition.channels.reduce((sum, channel) => sum + channel.installs, 0),
      report.totals.counts[2],
    );
  });
});
