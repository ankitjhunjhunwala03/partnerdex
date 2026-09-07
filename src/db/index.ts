import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../config.js';
import { migrate } from './migrate.js';
import { SCHEMA_SQL } from './schema.js';

export type Db = Database.Database;

let handle: Db | null = null;

export function getDb(): Db {
  if (handle) return handle;

  const { runtime } = getConfig();
  if (runtime.databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(runtime.databasePath), { recursive: true });
  }

  const db = new Database(runtime.databasePath);
  db.pragma('busy_timeout = 5000');
  // Schema first, then the changes it cannot express. A migration may reference
  // a table SCHEMA_SQL creates, so the order is load-bearing.
  db.exec(SCHEMA_SQL);
  migrate(db);

  handle = db;
  return db;
}

export function closeDb(): void {
  handle?.close();
  handle = null;
}

/** Test seam: an in-memory database with the schema already applied. */
export function useDb(db: Db): void {
  handle = db;
}

export interface SyncState {
  cursor: string | null;
  /**
   * The window `cursor` was produced under, or null when it is not known.
   *
   * Null on a cursor written before this column existed, and on the cursors of
   * callers that do not paginate a time-windowed connection at all. Callers
   * that do compare it against the window they are about to query, and discard
   * the cursor when the two differ — see `syncTransactionsFor`.
   */
  cursorWindow: string | null;
  syncedThrough: string | null;
}

export function readSyncState(db: Db, key: string): SyncState {
  const row = db
    .prepare('SELECT cursor, cursor_window, synced_through FROM sync_state WHERE key = ?')
    .get(key) as
    | { cursor: string | null; cursor_window: string | null; synced_through: string | null }
    | undefined;
  return {
    cursor: row?.cursor ?? null,
    cursorWindow: row?.cursor_window ?? null,
    syncedThrough: row?.synced_through ?? null,
  };
}

export function writeSyncState(
  db: Db,
  key: string,
  patch: { cursor?: string | null; cursorWindow?: string | null; syncedThrough?: string | null },
): void {
  const current = readSyncState(db, key);
  /*
   * A cursor and its window are one fact, so clearing the cursor clears the
   * window with it unless the caller says otherwise. Left behind, the stale
   * window would be compared against by the next pass and could match by
   * coincidence — a cursor with no window is at least honestly unknown.
   */
  const cursor = patch.cursor === undefined ? current.cursor : patch.cursor;
  const cursorWindow =
    patch.cursorWindow !== undefined
      ? patch.cursorWindow
      : cursor === null
        ? null
        : current.cursorWindow;
  db.prepare(
    `INSERT INTO sync_state (key, cursor, cursor_window, synced_through, updated_at)
     VALUES (@key, @cursor, @cursorWindow, @syncedThrough, @updatedAt)
     ON CONFLICT(key) DO UPDATE SET
       cursor = excluded.cursor,
       cursor_window = excluded.cursor_window,
       synced_through = excluded.synced_through,
       updated_at = excluded.updated_at`,
  ).run({
    key,
    cursor,
    cursorWindow,
    syncedThrough: patch.syncedThrough === undefined ? current.syncedThrough : patch.syncedThrough,
    updatedAt: new Date().toISOString(),
  });
}
