import { getConfig } from '../config.js';
import { getDb, type Db } from '../db/index.js';
import { usageKinds } from '../metrics/asof.js';
import { asOfPredicate, PRICED } from '../metrics/predicate.js';

/**
 * Where a merchant came from: the source, medium and campaign of the listing
 * visit that led to their install.
 *
 * Two collected tables, joined on the browser cookie they share. A listing
 * event knows its session's source but not the shop; GA4's install event knows
 * the shop but not the source. Nothing else in the export has both.
 *
 * **What this cannot see.** The same seam the affiliate join has to cross, and
 * the same price: a merchant who reads the listing on one device and installs
 * on another is two cookies and cannot be joined, and a browser that blocks
 * analytics leaves no visit at all. Both come back with no source — they look
 * like an install nobody can explain, which is what they are. Read the result
 * as a sample of installs, not a census; the Partner API's install count is the
 * denominator.
 */

/**
 * How long a visit stays eligible to explain an install.
 *
 * Matches the affiliate referral window, so the two answers to "where did this
 * merchant come from" are measured over the same span.
 */
export const ACQUISITION_WINDOW_DAYS = 30;

/**
 * GA4's two spellings of "no source". `(direct)` is a visit with no UTMs and no
 * referrer; `(not set)` is a session GA4 could not attribute at all. Both are
 * kept apart from a real source so they lose to one, which is GA4's own last
 * non-direct click rule carried across sessions.
 */
const DIRECT_SOURCE = '(direct)';
const NOT_SET = '(not set)';

/** What the App Store's own traffic is credited to when GA4 has no answer. */
export const APP_STORE_SOURCE = 'shopify app store';

export interface ShopAcquisition {
  appId: string;
  /** The Shopify shop id, the same value as `shops.id`. */
  shopId: string;
  shopDomain: string | null;
  /** GA4's account of the first install in range, not the Partner API's. */
  installedAt: string;
  /** Null when no listing visit could be joined to the install. */
  source: string | null;
  medium: string | null;
  campaign: string | null;
  /** When the credited visit happened. */
  visitedAt: string | null;
}

export interface Touch {
  occurredAt: string;
  source: string | null;
  medium: string | null;
  campaign: string | null;
}

function isDirect(touch: Touch): boolean {
  return !touch.source || touch.source === DIRECT_SOURCE || touch.source === NOT_SET;
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * A visit's source, filling in where GA4 has none.
 *
 * GA4 answers `(not set)` for most traffic that moves *inside* the App Store —
 * a merchant searching the store, picking from autocomplete, or arriving from
 * their Shopify admin — because none of it starts a fresh attributed session.
 * On a real listing that was the single largest "source", hiding the store's
 * own search behind a label that means "unknown". The URL and referrer still
 * say where the visit came from, so they are read instead:
 *
 *   - `surface_type` / `surface_detail` are the App Store's own placement
 *     parameters. The type is the medium (search, category, collection…) and
 *     the detail — for a search, what the merchant typed — is the campaign.
 *   - otherwise the referrer's host, as GA4 itself would have named it.
 *
 * A source GA4 did give is never second-guessed.
 */
export function resolveTouch(
  touch: Touch & { pageLocation?: string | null; pageReferrer?: string | null },
): Touch {
  const base = {
    occurredAt: touch.occurredAt,
    source: touch.source,
    medium: touch.medium,
    campaign: touch.campaign,
  };
  if (touch.source && touch.source !== NOT_SET) return base;

  let params: URLSearchParams | null = null;
  try {
    params = touch.pageLocation ? new URL(touch.pageLocation).searchParams : null;
  } catch {
    params = null;
  }
  const surfaceType = params?.get('surface_type')?.trim();
  const surfaceDetail = params?.get('surface_detail')?.trim();
  const storeSource = params?.get('st_source')?.trim();
  if (surfaceType || storeSource || surfaceDetail) {
    return {
      ...base,
      source: APP_STORE_SOURCE,
      medium: surfaceType || storeSource || 'browse',
      campaign: surfaceDetail || null,
    };
  }

  const referrer = hostOf(touch.pageReferrer);
  if (referrer === 'apps.shopify.com') return { ...base, source: APP_STORE_SOURCE, medium: 'browse' };
  if (referrer && referrer !== hostOf(touch.pageLocation)) {
    return { ...base, source: referrer, medium: 'referral', campaign: null };
  }
  return base;
}

/**
 * The visit an install is credited to: the latest one with a real source, and
 * only if there is none, the latest visit at all.
 *
 * Last touch because GA4's own session field already applies last click, and
 * crediting across sessions any other way would disagree with Google's reports
 * for the same merchant. Direct loses to anything, because a merchant typing
 * the URL back in a week after clicking an ad is still the ad's merchant.
 */
export function creditedTouch(touches: Touch[]): Touch | null {
  let best: Touch | null = null;
  for (const touch of touches) {
    if (!best) {
      best = touch;
      continue;
    }
    const bestDirect = isDirect(best);
    const direct = isDirect(touch);
    if (direct !== bestDirect) {
      if (bestDirect) best = touch;
      continue;
    }
    if (touch.occurredAt > best.occurredAt) best = touch;
  }
  return best;
}

interface CandidateRow {
  app_id: string;
  shop_id: string;
  shop_domain: string | null;
  installed_at: string;
  occurred_at: string | null;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  page_location: string | null;
  page_referrer: string | null;
}

export interface AcquisitionOptions {
  /** Earliest install to consider. Inclusive. */
  from: string;
  /** Latest install to consider. Exclusive. */
  to: string;
  windowDays?: number;
}

/**
 * One row per shop that GA4 saw install in the range, with the visit it is
 * credited to.
 *
 * SQL narrows to the visits that could qualify; the rule above picks among
 * them. A shop installed more than once in range is credited from its first
 * install — the reinstall is a returning merchant, not a new acquisition.
 */
export function shopAcquisitions(
  appIds: string[],
  options: AcquisitionOptions,
  db: Db = getDb(),
): ShopAcquisition[] {
  if (appIds.length === 0) return [];
  const windowDays = options.windowDays ?? ACQUISITION_WINDOW_DAYS;
  const placeholders = appIds.map(() => '?').join(',');

  /*
   * Window bounds are compared as ISO strings. Both columns are written by
   * `toISOString()`, so the string order is the time order, and the window's
   * start is computed with the same format via `strftime`.
   */
  const rows = db
    .prepare(
      `WITH first_install AS (
         SELECT app_id, shop_id, MAX(shop_domain) AS shop_domain, MIN(installed_at) AS installed_at
           FROM listing_installs
          WHERE app_id IN (${placeholders})
            AND installed_at >= ? AND installed_at < ?
          GROUP BY app_id, shop_id
       ),
       browsers AS (
         SELECT DISTINCT f.app_id, f.shop_id, f.installed_at, i.anonymous_id
           FROM first_install f
           JOIN listing_installs i
             ON i.app_id = f.app_id AND i.shop_id = f.shop_id AND i.installed_at = f.installed_at
       )
       SELECT f.app_id, f.shop_id, f.shop_domain, f.installed_at,
              e.occurred_at, e.source, e.medium, e.campaign, e.page_location, e.page_referrer
         FROM first_install f
         LEFT JOIN browsers b
           ON b.app_id = f.app_id AND b.shop_id = f.shop_id
         LEFT JOIN listing_events e
           ON e.app_id = b.app_id
          AND e.anonymous_id = b.anonymous_id
          AND e.occurred_at <= b.installed_at
          AND e.occurred_at >= strftime('%Y-%m-%dT%H:%M:%fZ', b.installed_at, ?)
        ORDER BY f.installed_at, f.shop_id`,
    )
    .all(...appIds, options.from, options.to, `-${windowDays} days`) as CandidateRow[];

  const byShop = new Map<string, { row: CandidateRow; touches: Touch[] }>();
  for (const row of rows) {
    const key = `${row.app_id}:${row.shop_id}`;
    let entry = byShop.get(key);
    if (!entry) {
      entry = { row, touches: [] };
      byShop.set(key, entry);
    }
    if (row.occurred_at) {
      entry.touches.push(
        resolveTouch({
          occurredAt: row.occurred_at,
          source: row.source,
          medium: row.medium,
          campaign: row.campaign,
          pageLocation: row.page_location,
          pageReferrer: row.page_referrer,
        }),
      );
    }
  }

  return [...byShop.values()].map(({ row, touches }) => {
    const touch = creditedTouch(touches);
    return {
      appId: row.app_id,
      shopId: row.shop_id,
      shopDomain: row.shop_domain,
      installedAt: row.installed_at,
      source: touch?.source ?? null,
      medium: touch?.medium ?? null,
      campaign: touch?.campaign ?? null,
      visitedAt: touch?.occurredAt ?? null,
    };
  });
}

/** One source / medium pair, and what the shops it brought in became. */
export interface AcquisitionChannel {
  source: string;
  medium: string;
  installs: number;
  /** Shops that paid something after installing — a priced plan or a usage charge. */
  paying: number;
  /** MRR those shops carry right now, composed the way the MRR card composes it. */
  mrr: number;
  /** Campaign names seen on the credited visits, most installs first. */
  campaigns: string[];
}

export interface AcquisitionSummary {
  /** Installs GA4 saw in the range — the most this table could ever explain. */
  tracked: number;
  /** Of those, the installs a listing visit could be joined to. */
  traced: number;
  channels: AcquisitionChannel[];
}

/**
 * A payment this long before GA4's install event still counts as following it.
 *
 * The two clocks are different systems: GA4 stamps the install when Shopify's
 * Measurement Protocol hit lands, and a merchant on a plan with no trial can
 * accept the charge in the same minute. Without the slack, the fastest
 * converters would be the ones reported as never paying.
 */
const PAYMENT_SLACK_MS = 86_400_000;

interface ShopOutcomeRow {
  app_id: string;
  shop_id: string;
  /** The latest payment the view counts: a priced plan converting, or a usage charge. */
  last_paid: string | null;
  mrr: number;
}

/**
 * Installs by source and medium over a range, with what each channel's shops
 * went on to pay.
 *
 * MRR is what those shops carry *now*, from the same two sources the MRR card
 * composes: priced subscriptions under its live predicate, and the recognized
 * usage rows of the kinds the reporting settings count. Reading subscriptions
 * alone reported zero for every channel of an app whose plans are zero-priced
 * and billed through usage — every one of its paying merchants was invisible.
 * A shop that has since churned contributes nothing.
 */
export function acquisitionSummary(
  appIds: string[],
  options: AcquisitionOptions & { now?: Date },
  db: Db = getDb(),
): AcquisitionSummary {
  const shops = shopAcquisitions(appIds, options, db);
  const traced = shops.filter((shop) => shop.source !== null);

  const outcomes = new Map<string, ShopOutcomeRow>();
  if (traced.length > 0) {
    const { reporting } = getConfig();
    const view = {
      appIds: [],
      includeAnnual: reporting.includeAnnual,
      includeTrials: false,
      includeUsage: reporting.includeUsage,
    };
    const live = asOfPredicate(view, '@asOf');
    const kinds = usageKinds(view);
    const rows = db
      .prepare(
        `WITH wanted AS (SELECT value AS key FROM json_each(@keys)),
         plans AS (
           SELECT s.app_id, s.shop_id,
                  MAX(CASE WHEN ${PRICED} THEN s.conversion_at END) AS last_paid,
                  COALESCE(SUM(CASE WHEN ${live.sql} THEN s.monthly_amount END), 0) AS mrr
             FROM subscriptions s
            WHERE s.is_test = 0
              AND s.app_id || ' ' || s.shop_id IN (SELECT key FROM wanted)
            GROUP BY s.app_id, s.shop_id
         ),
         usage AS (
           SELECT u.app_id, u.shop_id,
                  MAX(u.created_at) AS last_paid,
                  COALESCE(SUM(CASE WHEN u.created_at <= @asOf AND u.through > @asOf
                                    THEN u.monthly_amount END), 0) AS mrr
             FROM usage_recognized_rows u
            WHERE u.kind IN (SELECT value FROM json_each(@kinds))
              AND u.app_id || ' ' || u.shop_id IN (SELECT key FROM wanted)
            GROUP BY u.app_id, u.shop_id
         )
         SELECT app_id, shop_id, MAX(last_paid) AS last_paid, SUM(mrr) AS mrr
           FROM (SELECT * FROM plans UNION ALL SELECT * FROM usage)
          GROUP BY app_id, shop_id`,
      )
      .all({
        ...live.params,
        asOf: (options.now ?? new Date()).toISOString(),
        keys: JSON.stringify(traced.map((shop) => `${shop.appId} ${shop.shopId}`)),
        kinds: JSON.stringify(kinds),
      }) as ShopOutcomeRow[];
    for (const row of rows) outcomes.set(`${row.app_id} ${row.shop_id}`, row);
  }

  const channels = new Map<string, AcquisitionChannel & { campaignCounts: Map<string, number> }>();
  for (const shop of traced) {
    const medium = shop.medium ?? '(not set)';
    const key = `${shop.source}\u0000${medium}`;
    let channel = channels.get(key);
    if (!channel) {
      channel = {
        source: shop.source!,
        medium,
        installs: 0,
        paying: 0,
        mrr: 0,
        campaigns: [],
        campaignCounts: new Map(),
      };
      channels.set(key, channel);
    }
    channel.installs += 1;

    const outcome = outcomes.get(`${shop.appId} ${shop.shopId}`);
    if (
      outcome?.last_paid &&
      Date.parse(outcome.last_paid) >= Date.parse(shop.installedAt) - PAYMENT_SLACK_MS
    ) {
      channel.paying += 1;
    }
    channel.mrr += outcome?.mrr ?? 0;

    if (shop.campaign && shop.campaign !== '(not set)') {
      channel.campaignCounts.set(shop.campaign, (channel.campaignCounts.get(shop.campaign) ?? 0) + 1);
    }
  }

  return {
    tracked: shops.length,
    traced: traced.length,
    channels: [...channels.values()]
      .map(({ campaignCounts, ...channel }) => ({
        ...channel,
        mrr: Math.round(channel.mrr * 100) / 100,
        campaigns: [...campaignCounts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([name]) => name),
      }))
      .sort((a, b) => b.installs - a.installs || b.mrr - a.mrr || a.source.localeCompare(b.source)),
  };
}
