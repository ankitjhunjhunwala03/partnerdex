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

/** Traffic from the App Store built into the Shopify admin. */
export const ADMIN_SOURCE = 'shopify admin';

/**
 * The `utm_source` Shopify stamps on its own links into a listing. Not a
 * channel by itself — the admin and the store both send it — so the store's
 * own `st_*` parameters beside it are read for the real answer.
 */
const SHOPIFY_UTM_SOURCE = 'shopify';

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
 *   - `st_source=admin-web` is the App Store inside the Shopify admin, and
 *     `st_campaign` says where in it (`admin-search` is its search box).
 *     Shopify also tags these links `utm_source=shopify`, which GA4 reports as
 *     a source with no medium — so that one source is read through too.
 *   - `surface_type` / `surface_detail` are the App Store's own placement
 *     parameters. The type is the medium (search, category, collection…) and
 *     the detail — for a search, what the merchant typed — is the campaign.
 *   - otherwise the referrer's host, as GA4 itself would have named it.
 *   - and with no referrer and no parameters at all, the visit is direct, which
 *     is GA4's own definition of it.
 *
 * Any other source GA4 gave is never second-guessed.
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
  const shopifyTagged = touch.source === SHOPIFY_UTM_SOURCE;
  if (touch.source && touch.source !== NOT_SET && !shopifyTagged) return base;

  let params: URLSearchParams | null = null;
  try {
    params = touch.pageLocation ? new URL(touch.pageLocation).searchParams : null;
  } catch {
    params = null;
  }
  const surfaceType = params?.get('surface_type')?.trim();
  const surfaceDetail = params?.get('surface_detail')?.trim();
  const storeSource = params?.get('st_source')?.trim();
  const storeCampaign = params?.get('st_campaign')?.trim();

  if (storeSource === 'admin-web') {
    return {
      ...base,
      source: ADMIN_SOURCE,
      medium: storeCampaign === 'admin-search' ? 'search' : storeCampaign || 'browse',
      campaign: surfaceDetail || null,
    };
  }
  if (shopifyTagged) return base;

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
  if (!referrer && !hasCampaignParams(params)) {
    return { ...base, source: DIRECT_SOURCE, medium: '(none)', campaign: null };
  }
  return base;
}

/** Whether a URL carries anything that names where its visitor came from. */
function hasCampaignParams(params: URLSearchParams | null): boolean {
  if (!params) return false;
  for (const key of params.keys()) {
    if (key.startsWith('utm_') || key.startsWith('st_') || key.startsWith('surface_')) return true;
    if (key === 'gclid' || key === 'fbclid' || key === 'mref' || key === 'ref') return true;
  }
  return false;
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

/**
 * How a channel row's installs were placed.
 *
 *   - `traced`        credited to a listing visit, by cookie or by timing
 *   - `no_visit`      GA4 recorded the install, but no listing visit could be
 *                     tied to it
 *   - `not_recorded`  GA4 has no record of the install at all
 *
 * The last two are rows rather than a footnote so the table adds up to the
 * Partner API's installs: a reader sees how big the unknown is, and what those
 * merchants are worth, instead of a sample that quietly reads as the whole.
 *
 * Both were checked against the full GA4 export, every event type and not just
 * the two the funnel reads, and they are what they say. Of the installs GA4
 * never recorded, three in four had no GA4 activity at all in the two minutes
 * before — the merchant never passed through the tracked listing page, which
 * is what installing from inside the Shopify admin looks like. Of the ones it
 * recorded with no visit, most browsers sent the install event and nothing
 * else, ever. There is nothing further in the export to match them on.
 */
export type ChannelKind = 'traced' | 'no_visit' | 'not_recorded';

/** What placed an install: the cookie match, else the timing of the click. */
export type MatchMethod = 'ga4' | 'timing';

export type MatchCounts = Record<MatchMethod, number>;

function noMatches(): MatchCounts {
  return { ga4: 0, timing: 0 };
}

/** One source / medium pair, and what the shops it brought in became. */
export interface AcquisitionChannel {
  kind: ChannelKind;
  source: string;
  medium: string;
  installs: number;
  /** How this row's installs were placed. Sums to `installs` for placed rows. */
  matchedBy: MatchCounts;
  /** Shops that paid something after installing — a priced plan or a usage charge. */
  paying: number;
  /** MRR those shops carry right now, composed the way the MRR card composes it. */
  mrr: number;
  /** Campaign names seen on the credited visits, most installs first. */
  campaigns: string[];
}

export interface AcquisitionSummary {
  /** The Partner API's installs in the range — every row below sums to this. */
  installs: number;
  /** Installs GA4 has an install event for. */
  recorded: number;
  /** Installs credited to a listing visit, by either match. */
  traced: number;
  /** How every placed install was placed. */
  matchedBy: MatchCounts;
  channels: AcquisitionChannel[];
}

/**
 * How close before an install an Add app click has to land to claim it.
 *
 * Measured, not chosen. On a real listing, where the cookie match already
 * knows the answer, the click precedes GA4's install event by 11 seconds at the
 * median and 27 at the 90th percentile, and the Partner API's install time
 * sits within two seconds of GA4's. A minute takes in essentially every real
 * pair while a listing with a few clicks a day almost never has two in it —
 * and when it does, the install is left unplaced rather than guessed. Checked
 * against the cookie match on the same data, the timing match picked the same
 * browser 143 times and a different one 3 times.
 */
export const CLICK_MATCH_SECONDS = 60;

/** Slack after the install, for the two clocks disagreeing by a second or two. */
const CLICK_MATCH_AFTER_SECONDS = 5;

/**
 * A payment this long before the install still counts as following it.
 *
 * The clocks are different systems, and a merchant on a plan with no trial can
 * accept the charge in the same minute as installing. Without the slack, the
 * fastest converters would be the ones reported as never paying.
 */
const PAYMENT_SLACK_MS = 86_400_000;

interface ShopOutcomeRow {
  app_id: string;
  shop_id: string;
  /** The latest payment the view counts: a priced plan converting, or a usage charge. */
  last_paid: string | null;
  mrr: number;
}

interface PartnerInstallRow {
  app_id: string;
  shop_id: string;
  installed_at: string;
}

interface TimingRow {
  app_id: string;
  shop_id: string;
  browsers: number;
  anonymous_id: string | null;
}

interface TouchRow {
  occurred_at: string;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  page_location: string | null;
  page_referrer: string | null;
}

/** ISO instant shifted by a number of seconds, in the format the tables store. */
function shiftIso(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

/**
 * What each shop has paid and carries now, from the same two sources the MRR
 * card composes: priced subscriptions under its live predicate, and the
 * recognized usage rows of the kinds the reporting settings count. Reading
 * subscriptions alone reported zero for every channel of an app whose plans are
 * zero-priced and billed through usage.
 */
function shopOutcomes(db: Db, keys: string[], now: Date): Map<string, ShopOutcomeRow> {
  const outcomes = new Map<string, ShopOutcomeRow>();
  if (keys.length === 0) return outcomes;

  const { reporting } = getConfig();
  const view = {
    appIds: [],
    includeAnnual: reporting.includeAnnual,
    includeTrials: false,
    includeUsage: reporting.includeUsage,
  };
  const live = asOfPredicate(view, '@asOf');
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
      asOf: now.toISOString(),
      keys: JSON.stringify(keys),
      kinds: JSON.stringify(usageKinds(view)),
    }) as ShopOutcomeRow[];
  for (const row of rows) outcomes.set(`${row.app_id} ${row.shop_id}`, row);
  return outcomes;
}

/**
 * The browser behind each install the cookie match could not place, read off
 * the one Add app click that landed just before it.
 *
 * Keyed on the Partner API's install time, so it also reaches installs GA4
 * never recorded. A click whose browser GA4 already tied to a *different* shop
 * is not eligible: that browser's install is known, and lending it to a second
 * shop would credit one visit twice. Two eligible browsers in the window and
 * the install stays unplaced.
 */
function browsersByTiming(db: Db, installs: PartnerInstallRow[]): Map<string, string> {
  const found = new Map<string, string>();
  if (installs.length === 0) return found;

  const rows = db
    .prepare(
      `WITH wanted AS (
         SELECT json_extract(value, '$.app')  AS app_id,
                json_extract(value, '$.shop') AS shop_id,
                json_extract(value, '$.from') AS click_from,
                json_extract(value, '$.to')   AS click_to
           FROM json_each(@installs)
       )
       SELECT w.app_id, w.shop_id,
              COUNT(DISTINCT e.anonymous_id) AS browsers,
              MAX(e.anonymous_id) AS anonymous_id
         FROM wanted w
         JOIN listing_events e
           ON e.app_id = w.app_id
          AND e.type = 'add_app_click'
          AND e.anonymous_id <> ''
          AND e.occurred_at >= w.click_from
          AND e.occurred_at <= w.click_to
        WHERE NOT EXISTS (
                SELECT 1 FROM listing_installs i
                 WHERE i.app_id = w.app_id
                   AND i.anonymous_id = e.anonymous_id
                   AND i.shop_id <> w.shop_id
              )
        GROUP BY w.app_id, w.shop_id`,
    )
    .all({
      installs: JSON.stringify(
        installs.map((install) => ({
          app: install.app_id,
          shop: install.shop_id,
          from: shiftIso(install.installed_at, -CLICK_MATCH_SECONDS),
          to: shiftIso(install.installed_at, CLICK_MATCH_AFTER_SECONDS),
        })),
      ),
    }) as TimingRow[];

  for (const row of rows) {
    if (row.browsers === 1 && row.anonymous_id) found.set(`${row.app_id} ${row.shop_id}`, row.anonymous_id);
  }
  return found;
}

/** The visits one browser made in the window before an install, resolved. */
function touchesBefore(
  db: Db,
  appId: string,
  anonymousId: string,
  installedAt: string,
  windowDays: number,
): Touch[] {
  const rows = db
    .prepare(
      `SELECT occurred_at, source, medium, campaign, page_location, page_referrer
         FROM listing_events
        WHERE app_id = ? AND anonymous_id = ?
          AND occurred_at <= ? AND occurred_at >= ?`,
    )
    .all(
      appId,
      anonymousId,
      shiftIso(installedAt, CLICK_MATCH_AFTER_SECONDS),
      shiftIso(installedAt, -windowDays * 86_400),
    ) as TouchRow[];
  return rows.map((row) =>
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

/**
 * Every install in a range, by where it came from, with what each channel's
 * shops went on to pay.
 *
 * Starts from the Partner API's installs — the same count as the funnel's
 * "Installed" step — so the rows add up to it. Each is placed by the first
 * match that works:
 *
 *   1. GA4's install event, joined to that browser's listing visits by cookie
 *   2. the one Add app click in the minute before the install, and that
 *      browser's visits — for installs whose cookie had no visits, and for
 *      installs GA4 never recorded at all
 *   3. otherwise a row saying whether GA4 saw the install at all
 *
 * MRR is what the shops carry *now*; one that has since churned adds nothing.
 */
export function acquisitionSummary(
  appIds: string[],
  options: AcquisitionOptions & { now?: Date },
  db: Db = getDb(),
): AcquisitionSummary {
  const windowDays = options.windowDays ?? ACQUISITION_WINDOW_DAYS;
  const empty: AcquisitionSummary = {
    installs: 0,
    recorded: 0,
    traced: 0,
    matchedBy: noMatches(),
    channels: [],
  };
  if (appIds.length === 0) return empty;

  // The same rule as the funnel's step 3: a merchant choosing the app, first
  // time or fifth, once per shop however often in the range.
  const installs = db
    .prepare(
      `SELECT app_id, shop_id, MIN(started_at) AS installed_at
         FROM install_intervals
        WHERE app_id IN (SELECT value FROM json_each(?))
          AND started_by = 'installed'
          AND shop_id <> ''
          AND started_at >= ? AND started_at < ?
        GROUP BY app_id, shop_id`,
    )
    .all(JSON.stringify(appIds), options.from, options.to) as PartnerInstallRow[];
  if (installs.length === 0) return empty;

  // GA4's installs, read a day wider than the range: the two systems stamp the
  // same install a second or two apart, which can straddle the range's edge.
  const ga4 = new Map<string, ShopAcquisition>();
  for (const shop of shopAcquisitions(
    appIds,
    { from: shiftIso(options.from, -86_400), to: shiftIso(options.to, 86_400), windowDays },
    db,
  )) {
    ga4.set(`${shop.appId} ${shop.shopId}`, shop);
  }

  const unplaced = installs.filter((install) => !ga4.get(`${install.app_id} ${install.shop_id}`)?.source);
  const byTiming = browsersByTiming(db, unplaced);

  type Placed = { install: PartnerInstallRow; kind: ChannelKind; touch: Touch | null; by: MatchMethod | null };
  const placed: Placed[] = installs.map((install) => {
    const key = `${install.app_id} ${install.shop_id}`;
    const seen = ga4.get(key);
    if (seen?.source) {
      return {
        install,
        kind: 'traced',
        by: 'ga4',
        touch: { occurredAt: seen.visitedAt!, source: seen.source, medium: seen.medium, campaign: seen.campaign },
      };
    }
    const browser = byTiming.get(key);
    const touch = browser
      ? creditedTouch(touchesBefore(db, install.app_id, browser, install.installed_at, windowDays))
      : null;
    if (touch?.source) return { install, kind: 'traced', by: 'timing', touch };
    return { install, kind: seen ? 'no_visit' : 'not_recorded', by: null, touch: null };
  });

  const outcomes = shopOutcomes(
    db,
    installs.map((install) => `${install.app_id} ${install.shop_id}`),
    options.now ?? new Date(),
  );

  const channels = new Map<string, AcquisitionChannel & { campaignCounts: Map<string, number> }>();
  const matchedBy = noMatches();
  for (const { install, kind, touch, by } of placed) {
    const source = touch ? touch.source! : kind;
    const medium = touch ? touch.medium ?? '(not set)' : '';
    const key = `${kind}\u0000${source}\u0000${medium}`;
    let channel = channels.get(key);
    if (!channel) {
      channel = {
        kind,
        source,
        medium,
        installs: 0,
        matchedBy: noMatches(),
        paying: 0,
        mrr: 0,
        campaigns: [],
        campaignCounts: new Map(),
      };
      channels.set(key, channel);
    }
    channel.installs += 1;
    if (by) {
      channel.matchedBy[by] += 1;
      matchedBy[by] += 1;
    }

    const outcome = outcomes.get(`${install.app_id} ${install.shop_id}`);
    if (
      outcome?.last_paid &&
      Date.parse(outcome.last_paid) >= Date.parse(install.installed_at) - PAYMENT_SLACK_MS
    ) {
      channel.paying += 1;
    }
    channel.mrr += outcome?.mrr ?? 0;

    const campaign = touch?.campaign;
    if (campaign && campaign !== '(not set)') {
      channel.campaignCounts.set(campaign, (channel.campaignCounts.get(campaign) ?? 0) + 1);
    }
  }

  // Unplaced rows last, whatever their size: they are the remainder, not a channel.
  const order: Record<ChannelKind, number> = { traced: 0, no_visit: 1, not_recorded: 2 };
  return {
    installs: installs.length,
    recorded: placed.filter(({ install }) => ga4.has(`${install.app_id} ${install.shop_id}`)).length,
    traced: placed.filter((entry) => entry.kind === 'traced').length,
    matchedBy,
    channels: [...channels.values()]
      .map(({ campaignCounts, ...channel }) => ({
        ...channel,
        mrr: Math.round(channel.mrr * 100) / 100,
        campaigns: [...campaignCounts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([name]) => name),
      }))
      .sort(
        (a, b) =>
          order[a.kind] - order[b.kind] ||
          b.installs - a.installs ||
          b.mrr - a.mrr ||
          a.source.localeCompare(b.source),
      ),
  };
}
