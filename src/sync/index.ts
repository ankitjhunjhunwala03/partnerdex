import { getConfig } from '../config.js';
import { getDb, readSyncState, writeSyncState, type Db } from '../db/index.js';
import { paginate, partnerQuery } from '../partner/client.js';
import {
  APP_EVENTS_QUERY,
  APP_QUERY,
  SALE_TRANSACTION_TYPES,
  SYNCED_EVENT_TYPES,
  TRANSACTIONS_QUERY,
} from '../partner/queries.js';
import { addDays, toUtcIso } from '../metrics/time.js';
import {
  insertAppEvents,
  insertTransactions,
  upsertApp,
  type AppEventNode,
  type TransactionNode,
} from './ingest.js';
import { rebuildDerivedTables } from './derive.js';
import { syncReviews, type ReviewSyncResult } from '../appstore/ingest.js';
import { syncListingEvents, type ListingSyncResult } from '../bigquery/ingest.js';

/**
 * Transactions and events can be recorded slightly after they occur, so each
 * incremental run re-reads a short overlap behind the previous watermark.
 * Inserts are idempotent, so re-reading is free apart from bandwidth.
 */
const OVERLAP_DAYS = 3;

export interface SyncProgress {
  (message: string): void;
}

const noop: SyncProgress = () => {};

function windowStart(db: Db, key: string, syncStartDate: string): string {
  const { syncedThrough } = readSyncState(db, key);
  if (!syncedThrough) return toUtcIso(`${syncStartDate}T00:00:00Z`);
  return toUtcIso(addDays(new Date(syncedThrough), -OVERLAP_DAYS));
}

export interface SyncOptions {
  /** Ignore stored watermarks and re-read everything from SYNC_START_DATE. */
  full?: boolean;
  onProgress?: SyncProgress;
}

/**
 * The Partner API has no "list my apps" query, so scope is resolved from the
 * configured allowlist when present and otherwise from whichever apps have
 * appeared on a transaction. That also keeps app ids out of the codebase.
 */
/**
 * Variables for the transactions query.
 *
 * `appId` must be **absent** rather than null when reporting on every app: the
 * Partner API coerces an explicit null to an empty string and rejects it with
 * "Invalid GID ''". Omitting the key leaves the argument unprovided, which is
 * what actually means "no filter".
 */
export function transactionVariables(
  appId: string | null,
  createdAtMin: string,
  types: readonly string[],
): Record<string, unknown> {
  return {
    createdAtMin,
    types,
    ...(appId ? { appId: `gid://partners/App/${appId}` } : {}),
  };
}

export function resolveScopedAppIds(db: Db): string[] {
  const { scope } = getConfig();
  if (scope.appIds.length > 0) return scope.appIds;
  const rows = db.prepare('SELECT id FROM apps ORDER BY id').all() as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

async function syncTransactionsFor(
  db: Db,
  appId: string | null,
  options: SyncOptions,
): Promise<number> {
  const { scope } = getConfig();
  const onProgress = options.onProgress ?? noop;
  const key = appId ? `transactions:${appId}` : 'transactions:all';

  if (options.full) writeSyncState(db, key, { cursor: null, syncedThrough: null });

  const createdAtMin = windowStart(db, key, scope.syncStartDate);
  const { cursor } = readSyncState(db, key);
  const startedAt = new Date().toISOString();

  let total = 0;
  let latest = createdAtMin;

  const pages = paginate<TransactionNode>(
    TRANSACTIONS_QUERY,
    transactionVariables(appId, createdAtMin, SALE_TRANSACTION_TYPES),
    (data) => data?.transactions,
    cursor,
  );

  for await (const page of pages) {
    total += insertTransactions(db, page.nodes);
    for (const node of page.nodes) {
      const at = toUtcIso(node.createdAt);
      if (at > latest) latest = at;
    }
    writeSyncState(db, key, { cursor: page.endCursor });
    onProgress(`  transactions: ${total} rows`);
  }

  // Cursor cleared only after a clean pass, so an interrupted run resumes.
  writeSyncState(db, key, { cursor: null, syncedThrough: total > 0 ? latest : startedAt });
  return total;
}

async function syncEventsFor(db: Db, appId: string, options: SyncOptions): Promise<number> {
  const { scope } = getConfig();
  const onProgress = options.onProgress ?? noop;
  const key = `events:${appId}`;

  if (options.full) writeSyncState(db, key, { cursor: null, syncedThrough: null });

  const occurredAtMin = windowStart(db, key, scope.syncStartDate);
  const { cursor } = readSyncState(db, key);
  const startedAt = new Date().toISOString();

  let total = 0;
  let latest = occurredAtMin;

  const pages = paginate<AppEventNode>(
    APP_EVENTS_QUERY,
    {
      appId: `gid://partners/App/${appId}`,
      occurredAtMin,
      types: SYNCED_EVENT_TYPES,
    },
    (data) => data?.app?.events,
    cursor,
  );

  for await (const page of pages) {
    total += insertAppEvents(db, appId, page.nodes);
    for (const node of page.nodes) {
      const at = toUtcIso(node.occurredAt);
      if (at > latest) latest = at;
    }
    writeSyncState(db, key, { cursor: page.endCursor });
    onProgress(`  events: ${total} rows`);
  }

  writeSyncState(db, key, { cursor: null, syncedThrough: total > 0 ? latest : startedAt });
  return total;
}

/** Confirms an allowlisted app id exists and records its name locally. */
async function confirmApp(db: Db, appId: string): Promise<boolean> {
  const data = await partnerQuery<{ app: { id: string; name: string; apiKey: string } | null }>(
    APP_QUERY,
    { appId: `gid://partners/App/${appId}` },
  );
  if (!data.app) return false;
  upsertApp(db, data.app);
  return true;
}

export interface SyncResult {
  apps: string[];
  transactions: number;
  events: number;
  subscriptions: number;
  installs: number;
  customerEvents: number;
  reviewEvents: number;
  reviews: ReviewSyncResult;
  listing: ListingSyncResult;
}

export async function runSync(options: SyncOptions = {}): Promise<SyncResult> {
  const db = getDb();
  const { scope } = getConfig();
  const onProgress = options.onProgress ?? noop;

  let transactions = 0;

  if (scope.appIds.length > 0) {
    onProgress(`Scope: ${scope.appIds.length} app(s) from PARTNER_APP_IDS.`);
    for (const appId of scope.appIds) {
      const exists = await confirmApp(db, appId);
      if (!exists) {
        throw new Error(
          `App id ${appId} from PARTNER_APP_IDS was not found in this organization.`,
        );
      }
    }
    for (const appId of scope.appIds) {
      onProgress(`Syncing transactions for app ${appId}...`);
      transactions += await syncTransactionsFor(db, appId, options);
    }
  } else {
    onProgress('Scope: every app with recorded transactions (PARTNER_APP_IDS is empty).');
    onProgress('Syncing transactions...');
    transactions += await syncTransactionsFor(db, null, options);
  }

  const appIds = resolveScopedAppIds(db);
  if (appIds.length === 0) {
    onProgress('No apps discovered. Set PARTNER_APP_IDS if your apps have no transactions yet.');
  }

  let events = 0;
  for (const appId of appIds) {
    onProgress(`Syncing events for app ${appId}...`);
    events += await syncEventsFor(db, appId, options);
  }

  // Before the rebuild, so a review that arrives this run is matched to a
  // customer and compiled onto their timeline in the same pass rather than
  // waiting out a sync.
  const reviews = await syncReviews(db, { full: options.full, onProgress });

  // The pre-install half of the funnel. Independent of everything above — it is
  // Google's data, not Shopify's — and quiet when BigQuery is not connected,
  // which is every install that has not filled in the settings page.
  const listing = await syncListingEvents(db, appIds, { full: options.full, onProgress });
  if (listing.rows > 0) {
    onProgress(`Listing traffic: ${listing.rows} event(s) across ${listing.apps.length} app(s).`);
  }

  onProgress('Rebuilding derived subscription and install indexes...');
  const derived = rebuildDerivedTables(db);

  return { apps: appIds, transactions, events, reviews, listing, ...derived };
}
