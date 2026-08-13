import { getDb, type Db } from '../db/index.js';

export { ADD_APP_CLICK_EVENT, LISTING_VIEW_EVENT } from './events.js';

/**
 * The BigQuery account, and which export each app reads from.
 *
 * Two levels, because the data really is at two levels. A Google Cloud project
 * and a service account are things a partner has *one* of; a GA4 export dataset
 * belongs to a GA4 *property*, and a partner who put a separate measurement id
 * on each listing has one dataset per app. So the credential and the project are
 * connection-level, and the dataset is per app with no fallback — an app without
 * one is not synced, rather than quietly reading another app's property.
 *
 * The credential never leaves this module in the direction of a reader. It is
 * written by `saveConnection`, read only by the client that opens a BigQuery
 * session, and described to the dashboard by `describe`, which returns the
 * account's own email and key id and nothing else.
 */

export class BigQueryError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'BigQueryError';
  }
}

/** The fields a service-account key must have before it is worth storing. */
interface ServiceAccountKey {
  type?: string;
  project_id?: string;
  client_email?: string;
  private_key?: string;
  private_key_id?: string;
}

export interface BigQueryConnection {
  projectId: string;
  /** Default processing location. An app whose dataset sits elsewhere overrides it. */
  location: string;
  credentials: string;
  clientEmail: string;
  privateKeyId: string;
  checkedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Everything about the connection that is safe to send to a browser. */
export interface BigQueryConnectionView {
  projectId: string;
  location: string;
  /** The service account, which is a name rather than a secret. */
  clientEmail: string;
  /** Last eight characters of the key id — enough to tell two keys apart. */
  keyHint: string;
  checkedAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

interface ConnectionRow {
  project_id: string;
  location: string;
  credentials: string;
  client_email: string;
  private_key_id: string;
  checked_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A BigQuery identifier we are about to interpolate into SQL.
 *
 * Dataset and table names cannot be bound as parameters — only values can — so
 * the project and dataset reach the query as text. That is safe exactly as far
 * as this check goes, which is why nothing else in this codebase builds a
 * BigQuery identifier from anything a request supplied.
 */
const IDENTIFIER = /^[A-Za-z0-9_-]{1,1024}$/;

export function assertIdentifier(value: string, field: string): string {
  const trimmed = value.trim();
  if (!IDENTIFIER.test(trimmed)) {
    throw new BigQueryError(
      `${field} must be letters, digits, hyphens or underscores, got "${value}".`,
    );
  }
  return trimmed;
}


/**
 * Parses and sanity-checks a pasted service-account key.
 *
 * The failure this guards against is not a malformed JSON file; it is the wrong
 * *kind* of file. An OAuth client secret and a service-account key are both JSON
 * downloads from the same console page, and the first fails at query time with
 * an authentication error that says nothing about which of them you pasted.
 */
export function parseServiceAccount(raw: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BigQueryError(
      'That does not parse as JSON. Paste the whole service-account key file, braces included.',
    );
  }

  const key = parsed as ServiceAccountKey;
  if (!key || typeof key !== 'object') {
    throw new BigQueryError('The service-account key must be a JSON object.');
  }
  if (key.type !== 'service_account') {
    throw new BigQueryError(
      `That JSON has type "${key.type ?? 'none'}". A service-account key has type "service_account" —` +
        ' an OAuth client secret downloaded from the same page will not work.',
    );
  }
  if (!key.client_email || !key.private_key) {
    throw new BigQueryError('The service-account key is missing client_email or private_key.');
  }
  return key;
}

function toConnection(row: ConnectionRow): BigQueryConnection {
  return {
    projectId: row.project_id,
    location: row.location,
    credentials: row.credentials,
    clientEmail: row.client_email,
    privateKeyId: row.private_key_id,
    checkedAt: row.checked_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The whole row, credential included. Only the query layer should call this. */
export function readConnection(db: Db = getDb()): BigQueryConnection | null {
  const row = db
    .prepare(`SELECT * FROM bigquery_connection WHERE id = 'default'`)
    .get() as ConnectionRow | undefined;
  return row ? toConnection(row) : null;
}

/** The same row with the key taken out, for anything a reader will see. */
export function describe(connection: BigQueryConnection): BigQueryConnectionView {
  const { credentials: _credentials, privateKeyId, createdAt: _createdAt, ...rest } = connection;
  return {
    ...rest,
    keyHint: privateKeyId ? `…${privateKeyId.slice(-8)}` : 'unknown key',
  };
}

export interface SaveConnectionInput {
  projectId: string;
  location?: string;
  /**
   * Absent on an edit that only changes the project or an event name, which is
   * the common case and must not require pasting a key that is already stored.
   */
  credentials?: string;
}

export function saveConnection(input: SaveConnectionInput, db: Db = getDb()): BigQueryConnection {
  const existing = readConnection(db);

  if (!existing && !input.credentials) {
    throw new BigQueryError('Paste a service-account key to connect BigQuery.');
  }

  const projectId = assertIdentifier(input.projectId, 'Project id');
  const location = assertIdentifier(input.location?.trim() || existing?.location || 'US', 'Location');
  let credentials = existing?.credentials ?? '';
  let clientEmail = existing?.clientEmail ?? '';
  let privateKeyId = existing?.privateKeyId ?? '';

  if (input.credentials) {
    const key = parseServiceAccount(input.credentials);
    credentials = input.credentials;
    clientEmail = key.client_email ?? '';
    privateKeyId = key.private_key_id ?? '';
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO bigquery_connection (
       id, project_id, location, credentials, client_email, private_key_id,
       checked_at, last_error, created_at, updated_at
     ) VALUES (
       'default', @projectId, @location, @credentials, @clientEmail, @privateKeyId,
       NULL, NULL, @now, @now
     )
     ON CONFLICT(id) DO UPDATE SET
       project_id = excluded.project_id,
       location = excluded.location,
       credentials = excluded.credentials,
       client_email = excluded.client_email,
       private_key_id = excluded.private_key_id,
       -- A saved change invalidates the last check: it may well be what broke
       -- the connection, and showing a green tick from the previous project
       -- would be the one thing worse than showing nothing.
       checked_at = NULL,
       last_error = NULL,
       updated_at = excluded.updated_at`,
  ).run({
    projectId,
    location,
    credentials,
    clientEmail,
    privateKeyId,
    now,
  });


  return readConnection(db)!;
}

export function removeConnection(db: Db = getDb()): boolean {
  const result = db.prepare(`DELETE FROM bigquery_connection WHERE id = 'default'`).run();
  return result.changes > 0;
}

/** Records the outcome of a connection check on the row itself. */
export function recordCheck(error: string | null, db: Db = getDb()): void {
  db.prepare(
    `UPDATE bigquery_connection
        SET checked_at = @at, last_error = @error
      WHERE id = 'default'`,
  ).run({ at: new Date().toISOString(), error });
}

/* --------------------------------------------------------- per-app sources */

/**
 * Where one app's listing traffic is, and how to recognise it once there.
 *
 * `dataset` is the one field with no fallback — it names a GA4 property, and
 * guessing which property belongs to an app is exactly the mistake that would
 * fill one listing's funnel with another's traffic. Null means "not configured",
 * and the sync skips the app rather than inventing a source.
 *
 * The rest resolve: `location` from the connection's default, `handle` from the
 * App Store listing already mapped on the Listings page, `apiKey` from what the
 * Partner API reported. A stored value only ever overrides.
 */
export interface AppSource {
  appId: string;
  appName: string | null;
  /** Null until a dataset is set. Nothing syncs for this app until it is. */
  dataset: string | null;
  location: string;
  /** True when this app's dataset sits somewhere other than the default. */
  locationOverridden: boolean;
  handle: string | null;
  apiKey: string | null;
  /** Listing events collected for this app so far. */
  eventCount: number;
  lastEventAt: string | null;
}

interface SourceRow {
  app_id: string;
  app_name: string | null;
  dataset: string | null;
  location: string | null;
  handle: string | null;
  api_key: string | null;
  listing_handle: string | null;
  app_api_key: string | null;
  event_count: number;
  last_event_at: string | null;
}

export function listAppSources(appIds: string[], db: Db = getDb()): AppSource[] {
  if (appIds.length === 0) return [];
  const connection = readConnection(db);
  const placeholders = appIds.map(() => '?').join(',');

  const rows = db
    .prepare(
      `SELECT a.id                AS app_id,
              a.name              AS app_name,
              s.dataset           AS dataset,
              s.location          AS location,
              s.handle            AS handle,
              s.api_key           AS api_key,
              l.handle            AS listing_handle,
              a.api_key           AS app_api_key,
              (SELECT COUNT(*) FROM listing_events e WHERE e.app_id = a.id)     AS event_count,
              (SELECT MAX(occurred_at) FROM listing_events e WHERE e.app_id = a.id) AS last_event_at
         FROM apps a
         LEFT JOIN bigquery_app_sources s ON s.app_id = a.id
         LEFT JOIN app_listings l ON l.app_id = a.id
        WHERE a.id IN (${placeholders})
        ORDER BY a.name`,
    )
    .all(...appIds) as SourceRow[];

  return rows.map((row) => ({
    appId: row.app_id,
    appName: row.app_name,
    dataset: row.dataset,
    location: row.location ?? connection?.location ?? 'US',
    locationOverridden: row.location !== null,
    handle: row.handle ?? row.listing_handle,
    apiKey: row.api_key ?? row.app_api_key,
    eventCount: row.event_count,
    lastEventAt: row.last_event_at,
  }));
}

export function resolveAppSource(appId: string, db: Db = getDb()): AppSource | null {
  return listAppSources([appId], db)[0] ?? null;
}

export interface SaveAppSourceInput {
  dataset?: string | null;
  location?: string | null;
  handle?: string | null;
  apiKey?: string | null;
}

/**
 * Sets one app's source. Passing an empty string for a field clears it — which
 * for `dataset` stops the app syncing, and for the rest hands the field back to
 * its default. That is the way out of a mistaken value rather than being stuck
 * with it.
 */
export function saveAppSource(
  appId: string,
  input: SaveAppSourceInput,
  db: Db = getDb(),
): AppSource {
  const clean = (
    value: string | null | undefined,
    field: string,
    identifier = false,
  ): string | null => {
    if (value === undefined || value === null) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return identifier ? assertIdentifier(trimmed, field) : trimmed;
  };

  const dataset = clean(input.dataset, 'Dataset', true);
  const location = clean(input.location, 'Location', true);
  const handle = clean(input.handle, 'Handle');
  const apiKey = clean(input.apiKey, 'API key');

  if (dataset === null && location === null && handle === null && apiKey === null) {
    db.prepare('DELETE FROM bigquery_app_sources WHERE app_id = ?').run(appId);
  } else {
    db.prepare(
      `INSERT INTO bigquery_app_sources (app_id, dataset, location, handle, api_key, updated_at)
       VALUES (@appId, @dataset, @location, @handle, @apiKey, @now)
       ON CONFLICT(app_id) DO UPDATE SET
         dataset = excluded.dataset,
         location = excluded.location,
         handle = excluded.handle,
         api_key = excluded.api_key,
         updated_at = excluded.updated_at`,
    ).run({ appId, dataset, location, handle, apiKey, now: new Date().toISOString() });
  }

  const source = resolveAppSource(appId, db);
  if (!source) throw new BigQueryError(`No app with id ${appId}.`, 404);
  return source;
}
