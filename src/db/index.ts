import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../config.js';
import { seedOrganizationsFromEnv } from '../orgs/store.js';
import { migrate, namespaceLegacyWatermarks } from './migrate.js';
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
  // Not a migration: it needs an organization, which the environment may not
  // have had on the open that added the column. See its own comment.
  namespaceLegacyWatermarks(db);
  /*
   * The environment's organizations, inserted if the table does not have them.
   *
   * Here rather than in `migrate()` because it is not a migration: it runs on
   * every open, and it has to, or an organization added to `fly secrets` after
   * the first boot would never arrive. It is an insert-if-absent and nothing
   * else — the table wins on every field of a row it already holds, including
   * the token, and a removed organization stays removed. `store.ts` states the
   * rule and why it points that way.
   */
  seedOrganizationsFromEnv(db, getConfig().partner.orgs);
  // After the schema, not before: `journal_mode = WAL` in the schema block is
  // what creates the `-wal` and `-shm` sidecars, and they hold the same data.
  restrictFileMode(runtime.databasePath);

  handle = db;
  return db;
}

/**
 * Take the group and world bits off the database and its WAL sidecars.
 *
 * SQLite creates these with the process umask, which on a default system means
 * 0644 — readable by every local account. What is in the file now includes live
 * Partner API tokens, one per organization, and the plaintext BigQuery
 * service-account key. On a single-tenant machine that is a local-only
 * exposure, but `chmod` costs nothing and the same file gets copied onto
 * laptops for debugging, where "every local account" is a much bigger set.
 *
 * Best effort on purpose. A volume mounted from a filesystem that does not
 * carry Unix modes must not stop the process starting over a hardening
 * measure — refusing to boot is a worse failure than a mode of 0644.
 */
function restrictFileMode(databasePath: string): void {
  if (databasePath === ':memory:') return;
  // The sidecars are created by SQLite when WAL mode engages, so they may not
  // exist yet on the first call and are re-checked on every open.
  for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
    } catch {
      // Nothing actionable, and nothing worth failing a boot over.
    }
  }
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
