import { getConfig } from '../config.js';
import { getDb, readSyncState, writeSyncState, type Db } from '../db/index.js';
import { addDays, toUtcIso, wallClockIn } from '../metrics/time.js';
import { connect, runQuery, type Connected } from './client.js';
import { ADD_APP_CLICK_EVENT, LISTING_VIEW_EVENT } from './events.js';
import {
  assertIdentifier,
  BigQueryError,
  listAppSources,
  readConnection,
  recordCheck,
  resolveAppSource,
  type AppSource,
} from './connection.js';

/**
 * Pulling the pre-install half of the funnel out of the GA4 BigQuery export.
 *
 * Everything a partner can know about a merchant *before* they install comes
 * from here. The Partner API begins at the install; the two steps in front of
 * it — someone reading the listing, someone clicking Install — exist only in
 * Google Analytics, and only if the partner put a GA4 measurement id on their
 * App Store listing.
 *
 * Two events carry it, both from Shopify's own listing instrumentation
 * (https://shopify.dev/docs/apps/launch/marketing/track-listing-traffic), and
 * both fixed rather than configured — see `events.ts`.
 *
 * There is also a server-side `shopify_app_install` carrying `shop_id` and
 * `api_key`, which this deliberately does not read: installs are already known
 * from the Partner API, completely and without depending on a cookie surviving
 * the redirect.
 */

/**
 * How far behind its own watermark each run re-reads.
 *
 * GA4's daily tables are not final when they first appear — Google backfills
 * late-arriving hits for hours afterwards. Re-reading the tail is what makes
 * this converge instead of leaving permanent holes; it costs nothing but bytes,
 * because every row carries a deterministic id and lands as an upsert.
 */
const LOOKBACK_HOURS = 6;

/** Rows per BigQuery page. Bounds memory on a property with real traffic. */
const BATCH_SIZE = 10_000;

/**
 * How far back a first sync reaches when nothing has been collected yet.
 *
 * `SYNC_START_DATE` defaults to 2015, and a first funnel sync that scans every
 * daily table a GA4 property has ever written is a bill rather than a backfill.
 * A year of listing traffic is more than any funnel view here can display.
 */
const DEFAULT_BACKFILL_DAYS = 365;

export type ListingEventType = 'listing_view' | 'add_app_click';

interface ExportRow {
  event_name: string;
  user_pseudo_id: string | null;
  /** GA4's User-ID, set by the site when it knows who someone is. */
  user_id: string | null;
  /** Present only where the event carried a shop, which client-side ones rarely do. */
  shop_url: string | null;
  shop_id: string | null;
  /** GA4 stores event time as microseconds since the epoch. */
  event_timestamp: number | string | { value?: string } | null;
  ga_session_id: number | string | null;
  page_location: string | null;
  page_referrer: string | null;
  source: string | null;
  medium: string | null;
  campaign: string | null;
}

/**
 * Who an event belongs to, in a fixed order of preference.
 *
 * The shop first: a myshopify domain or a shop id names a merchant, and two
 * events carrying the same one are the same merchant however many browsers they
 * used. Then GA4's User-ID, which the site sets when it can identify someone.
 * Only then the browser cookie, which is where almost every pre-install event
 * ends up — nobody has identified themselves yet by definition.
 *
 * Resolved at write time so the funnel counts one column and the order of
 * preference lives in one place.
 */
export function resolveUserKey(row: {
  shop_url?: string | null;
  shop_id?: string | null;
  user_id?: string | null;
  user_pseudo_id?: string | null;
}): string {
  const shopUrl = row.shop_url?.trim();
  if (shopUrl) return `shop:${shopUrl.toLowerCase()}`;

  const shopId = row.shop_id?.trim();
  if (shopId) return `shop:${shopId}`;

  const userId = row.user_id?.trim();
  if (userId) return `user:${userId}`;

  const pseudo = row.user_pseudo_id?.trim();
  return pseudo ? `ga:${pseudo}` : '';
}

/** BigQuery hands INT64 back as a string, a number, or a wrapper. Flatten it. */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
    return toNumber((value as { value?: unknown }).value);
  }
  return null;
}

/** `YYYYMMDD`, the suffix GA4 shards its daily tables by. */
function tableSuffix(instant: Date): string {
  return instant.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * The regex that decides an event belongs to one app.
 *
 * A GA4 property can carry several listings — a partner with five apps commonly
 * points all five at one measurement id — and the only thing on a listing-page
 * event that names the app is the URL. Anchoring on a path boundary keeps
 * `stock-sync` from also matching `stock-sync-pro`.
 *
 * The handle comes from `app_listings`, which validates it as a slug on the way
 * in, so there is nothing here to escape. The check is repeated anyway: this
 * string reaches BigQuery as a bound parameter, but a handle that has picked up
 * a regex metacharacter would silently change what the funnel counts.
 */
export function handlePattern(handle: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(handle)) {
    throw new BigQueryError(
      `"${handle}" is not an App Store handle. Use the slug from apps.shopify.com/<handle>.`,
    );
  }
  return `(?i)/${handle}(?:[/?#]|$)`;
}

/**
 * The extraction query.
 *
 * `event_params` is a repeated record, so each scalar is pulled out with its own
 * correlated subquery rather than by unnesting the whole array and pivoting —
 * same result, and it keeps the row shape flat enough to read.
 *
 * Note what the wildcard does *not* match. GA4 also writes `events_intraday_*`
 * tables for the current day; their suffix sorts after any `YYYYMMDD`, so the
 * BETWEEN below excludes them. That is deliberate — intraday rows are rewritten
 * into the daily table later — and it is why today's traffic reaches the funnel
 * a day late.
 */
function extractionQuery(projectId: string, dataset: string, filterByHandle: boolean): string {
  const table = `\`${projectId}.${dataset}.events_*\``;
  const param = (key: string) =>
    `(SELECT value.string_value FROM UNNEST(e.event_params) WHERE key = '${key}')`;

  return `
    SELECT
      e.event_name                     AS event_name,
      e.user_pseudo_id                 AS user_pseudo_id,
      e.user_id                        AS user_id,
      ${param('shop_url')}             AS shop_url,
      CAST(
        COALESCE(
          (SELECT value.int_value FROM UNNEST(e.event_params) WHERE key = 'shop_id'),
          SAFE_CAST(${param('shop_id')} AS INT64)
        ) AS STRING
      )                                AS shop_id,
      e.event_timestamp                AS event_timestamp,
      (SELECT value.int_value FROM UNNEST(e.event_params) WHERE key = 'ga_session_id')
                                       AS ga_session_id,
      ${param('page_location')}        AS page_location,
      ${param('page_referrer')}        AS page_referrer,
      e.traffic_source.source          AS source,
      e.traffic_source.medium          AS medium,
      e.traffic_source.name            AS campaign
    FROM ${table} e
    WHERE e._TABLE_SUFFIX BETWEEN @fromSuffix AND @toSuffix
      AND e.event_name IN UNNEST(@eventNames)
      AND e.event_timestamp >= @cursorMicros
      ${
        filterByHandle
          ? `AND REGEXP_CONTAINS(COALESCE(${param('page_location')}, ''), @handlePattern)`
          : ''
      }
    ORDER BY e.event_timestamp
    LIMIT @batchSize
  `;
}

interface InsertRow {
  event_id: string;
  app_id: string;
  type: ListingEventType;
  occurred_at: string;
  user_key: string;
  anonymous_id: string;
  session_id: string;
  page_location: string | null;
  page_referrer: string | null;
  source: string | null;
  medium: string | null;
  campaign: string | null;
}

function writeEvents(db: Db, rows: InsertRow[]): number {
  if (rows.length === 0) return 0;

  const statement = db.prepare(
    `INSERT INTO listing_events (
       event_id, app_id, type, occurred_at, user_key, anonymous_id, session_id,
       page_location, page_referrer, source, medium, campaign
     ) VALUES (
       @event_id, @app_id, @type, @occurred_at, @user_key, @anonymous_id, @session_id,
       @page_location, @page_referrer, @source, @medium, @campaign
     )
     ON CONFLICT(event_id) DO UPDATE SET
       occurred_at   = excluded.occurred_at,
       user_key      = excluded.user_key,
       page_location = excluded.page_location,
       page_referrer = excluded.page_referrer,
       source        = excluded.source,
       medium        = excluded.medium,
       campaign      = excluded.campaign`,
  );

  const write = db.transaction((batch: InsertRow[]) => {
    for (const row of batch) statement.run(row);
  });
  write(rows);
  return rows.length;
}

export interface ListingSyncResult {
  /** Apps that had a resolvable source and were queried. */
  apps: string[];
  rows: number;
  /** Apps skipped, and why — surfaced on the settings page rather than logged. */
  skipped: Array<{ appId: string; reason: string }>;
}

export interface ListingSyncOptions {
  full?: boolean;
  onProgress?: (message: string) => void;
  now?: Date;
}

/**
 * Where this run starts reading for one app.
 *
 * A stored watermark is walked back by the lookback overlap. Without one, the
 * floor is whichever is later of `SYNC_START_DATE` and the backfill window —
 * "everything since 2015" is a cost, not a feature, on a daily-sharded export.
 */
function startInstant(db: Db, key: string, now: Date, full: boolean): Date {
  const { scope } = getConfig();
  const configured = new Date(`${scope.syncStartDate}T00:00:00Z`);
  const backfillFloor = addDays(now, -DEFAULT_BACKFILL_DAYS);
  const floor = configured.getTime() > backfillFloor.getTime() ? configured : backfillFloor;

  if (full) return floor;

  const { syncedThrough } = readSyncState(db, key);
  if (!syncedThrough) return floor;
  return new Date(new Date(syncedThrough).getTime() - LOOKBACK_HOURS * 3_600_000);
}

async function syncOneApp(
  db: Db,
  connected: Connected,
  source: AppSource,
  /**
   * True when another app in scope reads the same dataset.
   *
   * This is what decides whether the handle filter runs, and it has to: the
   * filter matches the handle in `page_location`, and a listing addresses some
   * of its own pages by numeric id instead — `apps.shopify.com/reviews/1384570`
   * is this listing's reviews tab and contains no handle at all. Applied to a
   * property that serves one listing, the filter therefore drops real views for
   * no benefit, because everything in that property already belongs to the one
   * app. It earns its cost only when a property is shared and the events have
   * to be told apart.
   */
  shared: boolean,
  options: ListingSyncOptions,
): Promise<number> {
  const { connection } = connected;
  const onProgress = options.onProgress ?? (() => {});
  const now = options.now ?? new Date();

  if (!source.dataset) throw new BigQueryError('No GA4 dataset set for this app.');
  const dataset = assertIdentifier(source.dataset, 'Dataset');
  const projectId = assertIdentifier(connection.projectId, 'Project id');

  const key = `bigquery:${source.appId}`;
  const from = startInstant(db, key, now, options.full ?? false);

  const typeFor = new Map<string, ListingEventType>([
    [LISTING_VIEW_EVENT, 'listing_view'],
    [ADD_APP_CLICK_EVENT, 'add_app_click'],
  ]);

  const byHandle = shared && source.handle !== null;
  const query = extractionQuery(projectId, dataset, byHandle);
  const params: Record<string, unknown> = {
    fromSuffix: tableSuffix(from),
    toSuffix: tableSuffix(now),
    eventNames: [...typeFor.keys()],
    batchSize: BATCH_SIZE,
    ...(byHandle ? { handlePattern: handlePattern(source.handle!) } : {}),
  };

  let cursorMicros = from.getTime() * 1000;
  let total = 0;
  let latest = from.toISOString();

  // Bounded rather than `while (true)`: a page that cannot advance its cursor
  // is caught below, but a pathological export should not be able to loop.
  for (let page = 0; page < 500; page += 1) {
    const rows = (await runQuery(
      connected,
      query,
      { ...params, cursorMicros },
      { location: source.location, dataset },
    )) as unknown as ExportRow[];
    if (rows.length === 0) break;

    const batch: InsertRow[] = [];
    let maxMicros = cursorMicros;

    for (const row of rows) {
      const micros = toNumber(row.event_timestamp);
      const anonymousId = row.user_pseudo_id ?? '';
      const type = typeFor.get(row.event_name);
      if (micros === null || !type) continue;
      if (micros > maxMicros) maxMicros = micros;

      const occurredAt = new Date(Math.floor(micros / 1000)).toISOString();
      if (occurredAt > latest) latest = occurredAt;

      batch.push({
        // GA4's own natural key. Deterministic, so the lookback overlap and a
        // re-run both converge instead of accumulating duplicates.
        event_id: `${source.appId}:${row.event_name}:${anonymousId}:${micros}`,
        app_id: source.appId,
        type,
        occurred_at: occurredAt,
        user_key: resolveUserKey(row),
        anonymous_id: anonymousId,
        session_id: String(toNumber(row.ga_session_id) ?? ''),
        page_location: row.page_location,
        page_referrer: row.page_referrer,
        source: row.source,
        medium: row.medium,
        campaign: row.campaign,
      });
    }

    total += writeEvents(db, batch);
    onProgress(`  listing events (${source.appName ?? source.appId}): ${total} rows`);

    // A short page is the last page. A page that could not move the cursor
    // would otherwise be re-read forever: every row shares one microsecond.
    if (rows.length < BATCH_SIZE) break;
    if (maxMicros <= cursorMicros) break;
    cursorMicros = maxMicros;
  }

  // Watermarked on the newest event actually seen, not on the clock: an export
  // that lands a day late must not have that day skipped on the next run.
  writeSyncState(db, key, { syncedThrough: total > 0 ? latest : toUtcIso(from) });
  return total;
}

/**
 * Pulls listing traffic for every app that has a resolvable GA4 source.
 *
 * Never throws for want of a connection. The funnel is one report among many
 * and BigQuery is optional; a partner who has not connected it should see an
 * unconfigured funnel, not a sync that fails and takes MRR down with it.
 */
export async function syncListingEvents(
  db: Db,
  appIds: string[],
  options: ListingSyncOptions = {},
): Promise<ListingSyncResult> {
  const onProgress = options.onProgress ?? (() => {});
  const empty: ListingSyncResult = { apps: [], rows: 0, skipped: [] };

  const connection = readConnection(db);
  if (!connection || appIds.length === 0) return empty;

  const sources = listAppSources(appIds, db);
  const skipped: ListingSyncResult['skipped'] = [];
  const runnable: AppSource[] = [];

  for (const source of sources) {
    if (!source.dataset) {
      // Not an error, and not something to guess around: an app whose GA4
      // property nobody has named is simply not part of the funnel's top yet.
      skipped.push({
        appId: source.appId,
        reason: 'No GA4 dataset set. Add one under Settings → BigQuery.',
      });
    } else {
      runnable.push(source);
    }
  }

  if (runnable.length === 0) return { ...empty, skipped };

  let connected: Connected;
  try {
    connected = await connect(connection);
  } catch (error) {
    // Recorded on the connection so the settings page can say what is wrong,
    // rather than disappearing into a log nobody is reading.
    recordCheck(error instanceof Error ? error.message : String(error), db);
    return { ...empty, skipped };
  }

  let rows = 0;
  const done: string[] = [];

  // How many apps in scope read each dataset. A property serving one listing
  // needs no handle filter — see `syncOneApp`.
  const perDataset = new Map<string, number>();
  for (const source of runnable) {
    perDataset.set(source.dataset!, (perDataset.get(source.dataset!) ?? 0) + 1);
  }

  for (const source of runnable) {
    try {
      const shared = (perDataset.get(source.dataset!) ?? 1) > 1;
      rows += await syncOneApp(db, connected, source, shared, options);
      done.push(source.appId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      skipped.push({ appId: source.appId, reason: message });
      recordCheck(message, db);
      onProgress(`  listing events (${source.appId}): ${message}`);
    }
  }

  if (done.length > 0) recordCheck(null, db);
  return { apps: done, rows, skipped };
}

/* ------------------------------------------------------------ diagnostics */

export interface ConnectionCheck {
  ok: boolean;
  error: string | null;
  /**
   * Datasets the service account can see in the project, which is also the list
   * an app's dataset field offers. A GA4 export is named `analytics_<property>`,
   * so this is normally the answer to "which dataset do I put where".
   */
  datasets: string[];
}

/**
 * Proves the account: the credential, the project, and that the BigQuery API is
 * on. Scans no event data — `INFORMATION_SCHEMA.SCHEMATA` is metadata.
 *
 * It deliberately checks no dataset, because at this level there is not one to
 * check. What it does instead is more useful: it lists the datasets that exist,
 * so filling in each app below becomes picking from a list rather than pasting
 * a name from another browser tab.
 */
export async function checkConnection(db: Db = getDb()): Promise<ConnectionCheck> {
  const connection = readConnection(db);
  if (!connection) return { ok: false, error: 'BigQuery is not connected.', datasets: [] };

  try {
    const connected = await connect(connection);
    const projectId = assertIdentifier(connection.projectId, 'Project id');
    const location = assertIdentifier(connection.location, 'Location');

    // SCHEMATA is region-qualified; `US` lives at `region-us`.
    const rows = (await runQuery(
      connected,
      `SELECT schema_name
         FROM \`${projectId}.region-${location.toLowerCase()}\`.INFORMATION_SCHEMA.SCHEMATA
        ORDER BY schema_name`,
      {},
      { location },
    )) as Array<{ schema_name: string }>;

    const datasets = rows.map((row) => row.schema_name);
    if (datasets.length === 0) {
      const error =
        `The account can reach \`${projectId}\`, but it has no datasets in ${location}. ` +
        'Check the location — a GA4 export in the EU is invisible to a US query.';
      recordCheck(error, db);
      return { ok: false, error, datasets: [] };
    }

    recordCheck(null, db);
    return { ok: true, error: null, datasets };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordCheck(message, db);
    return { ok: false, error: message, datasets: [] };
  }
}

export interface AppSourceCheck {
  ok: boolean;
  error: string | null;
  /** GA4 daily tables found in this app's dataset, and the span they cover. */
  tables: number;
  earliest: string | null;
  latest: string | null;
  /**
   * Set only when the GA4 property's day does not start when the dashboard's
   * does. Nothing is wrong with the data — the two just cut the calendar at
   * different instants, and every daily column disagrees with Google's until
   * they are made to match.
   */
  timezoneWarning: string | null;
}

/**
 * The GA4 property's UTC offset, inferred from where its days begin.
 *
 * GA4 stamps every row with `event_date` in the *property's* timezone and
 * `event_timestamp` in UTC. Neither states the offset, but the two together
 * bracket it: the earliest event on a date must fall after local midnight, and
 * the latest before the next one. Taking the tightest bracket over several days
 * pins it to within the gap between the first event and midnight.
 *
 * Returned in minutes, rounded to the quarter hour every real zone lands on.
 */
function inferOffsetMinutes(
  days: Array<{ date: string; firstUtcMs: number; lastUtcMs: number }>,
): number | null {
  let lower = -Infinity;
  let upper = Infinity;

  for (const day of days) {
    const midnightUtc = Date.parse(
      `${day.date.slice(0, 4)}-${day.date.slice(4, 6)}-${day.date.slice(6, 8)}T00:00:00Z`,
    );
    if (Number.isNaN(midnightUtc)) continue;
    // local(first) >= midnight  =>  offset >= midnight - first
    lower = Math.max(lower, midnightUtc - day.firstUtcMs);
    // local(last) < midnight + 24h  =>  offset < midnight + 24h - last
    upper = Math.min(upper, midnightUtc + 86_400_000 - day.lastUtcMs);
  }

  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) return null;
  const midpoint = (lower + upper) / 2 / 60_000;
  return Math.round(midpoint / 15) * 15;
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * Proves one app's dataset really is a GA4 export, and how far back it goes.
 *
 * Separate from the account check because it fails for entirely different
 * reasons — a dataset that exists but was never linked to a GA4 property, or an
 * export in a different region — and because with a dataset per app there is no
 * single answer to "is it working".
 */
export async function checkAppSource(
  appId: string,
  db: Db = getDb(),
  now: Date = new Date(),
): Promise<AppSourceCheck> {
  const blank = { tables: 0, earliest: null, latest: null, timezoneWarning: null };
  const connection = readConnection(db);
  if (!connection) return { ok: false, error: 'BigQuery is not connected.', ...blank };

  const source = resolveAppSource(appId, db);
  if (!source) return { ok: false, error: `No app with id ${appId}.`, ...blank };
  if (!source.dataset) {
    return { ok: false, error: 'No GA4 dataset set for this app.', ...blank };
  }

  try {
    const connected = await connect(connection);
    const projectId = assertIdentifier(connection.projectId, 'Project id');
    const dataset = assertIdentifier(source.dataset, 'Dataset');

    const rows = (await runQuery(
      connected,
      `SELECT COUNT(*) AS tables,
              MIN(table_name) AS earliest,
              MAX(table_name) AS latest
         FROM \`${projectId}.${dataset}.INFORMATION_SCHEMA.TABLES\`
        WHERE table_name LIKE 'events_%'`,
      {},
      { location: source.location, dataset },
    )) as Array<{ tables: unknown; earliest: string | null; latest: string | null }>;

    const row = rows[0];
    const tables = toNumber(row?.tables) ?? 0;
    if (tables === 0) {
      return {
        ok: false,
        error:
          `\`${dataset}\` exists but holds no GA4 export tables. Check that the GA4 property's ` +
          'BigQuery Link is on, and that this is the dataset it writes to.',
        ...blank,
      };
    }

    return {
      ok: true,
      error: null,
      tables,
      earliest: readableSuffix(row?.earliest ?? null),
      latest: readableSuffix(row?.latest ?? null),
      timezoneWarning: await compareTimezone(connected, projectId, dataset, source, now),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...blank,
    };
  }
}

/**
 * Does the GA4 property cut its days where this dashboard cuts its own?
 *
 * If not, every daily column is a different slice of time from the one Google
 * shows, and the two disagree by a few visitors each day for no visible reason.
 * That is the hardest kind of wrong number to chase — nothing is broken, the
 * totals are close, and only a day-by-day comparison reveals it — so it is
 * worth one small scan to say so out loud.
 */
async function compareTimezone(
  connected: Connected,
  projectId: string,
  dataset: string,
  source: AppSource,
  now: Date,
): Promise<string | null> {
  try {
    const rows = (await runQuery(
      connected,
      `SELECT event_date AS date,
              MIN(event_timestamp) AS first_micros,
              MAX(event_timestamp) AS last_micros
         FROM \`${projectId}.${dataset}.events_*\`
        WHERE _TABLE_SUFFIX BETWEEN @fromSuffix AND @toSuffix
        GROUP BY date`,
      { fromSuffix: tableSuffix(addDays(now, -7)), toSuffix: tableSuffix(addDays(now, -1)) },
      { location: source.location, dataset },
    )) as Array<{ date: string; first_micros: unknown; last_micros: unknown }>;

    const days = rows
      .map((row) => ({
        date: row.date,
        firstUtcMs: (toNumber(row.first_micros) ?? 0) / 1000,
        lastUtcMs: (toNumber(row.last_micros) ?? 0) / 1000,
      }))
      .filter((day) => day.firstUtcMs > 0);

    const propertyOffset = inferOffsetMinutes(days);
    if (propertyOffset === null) return null;

    const { runtime } = getConfig();
    const reportingOffset = Math.round(offsetMinutesAt(now, runtime.timezone));
    if (propertyOffset === reportingOffset) return null;

    return (
      `This GA4 property's day starts at ${formatOffset(propertyOffset)}, but reports are bucketed ` +
      `in ${runtime.timezone} (${formatOffset(reportingOffset)}). Daily columns will not line up ` +
      `with Google's until REPORTING_TIMEZONE matches the property.`
    );
  } catch {
    // A diagnostic, not a gate. The dataset already answered the question the
    // check was really asked.
    return null;
  }
}

/** How far `timeZone` is from UTC at a given instant, in minutes. */
function offsetMinutesAt(instant: Date, timeZone: string): number {
  const wall = wallClockIn(instant, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return (asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000;
}

/** `events_20250131` -> `2025-01-31`. Intraday tables have no date to show. */
function readableSuffix(tableName: string | null): string | null {
  const match = tableName?.match(/^events_(\d{4})(\d{2})(\d{2})$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

