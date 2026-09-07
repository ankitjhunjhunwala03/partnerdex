import type Database from 'better-sqlite3';
import { ADD_APP_CLICK_EVENT, LISTING_VIEW_EVENT } from '../bigquery/events.js';
import { primaryEnvOrg } from '../config.js';

type Db = Database.Database;

/**
 * Schema changes `CREATE TABLE IF NOT EXISTS` cannot make on its own.
 *
 * SCHEMA_SQL is idempotent for a *new* database and silent for an existing one:
 * a table that is already there is left exactly as it was, including columns
 * that have since moved or been dropped. Closing that gap needs a record of
 * what a database has already seen, and SQLite ships one — `PRAGMA
 * user_version`, an integer in the file header that costs nothing to read.
 *
 * Minimal on purpose: read the pragma, run each pending up() inside a
 * transaction, bump the version. No down-migrations, no framework, no ledger
 * table.
 *
 * Every migration body below is also individually idempotent — each one checks
 * the database before it writes. That is deliberate belt and braces, not
 * redundancy. Migrations 1 and 2 were previously applied by an unversioned
 * function that ran on every open, so databases exist that hold the changes
 * while user_version is still 0; replaying them has to be a no-op rather than a
 * `duplicate column name` crash. Later migrations are free to drop the checks
 * where the change genuinely cannot be detected after the fact.
 */

export interface Migration {
  version: number;
  up: (db: Db) => void;
}

/** The column names a table currently has, or an empty set if it has none. */
function columns(db: Db, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

export const MIGRATIONS: Migration[] = [
  /*
   * The BigQuery connection stopped carrying per-app and per-spelling settings.
   *
   * Two changes with one cause: values that looked like configuration were not.
   * The GA4 export dataset is per *property*, so a partner running one property
   * per listing has a dataset per app and a single connection-level value made
   * the common case the awkward one. The GA4 event names had exactly one
   * spelling that works, and a field offering to change them only offered a way
   * to break the report.
   *
   * Dropping the event names is the destructive half. A database configured
   * before this holds whichever names were entered and the listing traffic
   * collected under them. Rows are typed by *step*, not by event name, so
   * anything pulled as `view_item` is already labelled "listing view" and would
   * sit beside the `page_view` rows counting the same visit twice. Where the
   * stored names differ from the ones now compiled in, the collected traffic
   * and its watermarks go, and the next sync re-reads the range. Nothing is
   * lost that BigQuery cannot re-serve.
   */
  {
    version: 1,
    up: (db) => {
      const connection = columns(db, 'bigquery_connection');
      if (connection.has('dataset')) {
        db.exec('ALTER TABLE bigquery_connection DROP COLUMN dataset');
      }

      if (connection.has('view_event') || connection.has('click_event')) {
        const row = db
          .prepare('SELECT view_event, click_event FROM bigquery_connection')
          .get() as { view_event?: string; click_event?: string } | undefined;

        if (
          row &&
          (row.view_event !== LISTING_VIEW_EVENT || row.click_event !== ADD_APP_CLICK_EVENT)
        ) {
          db.exec('DELETE FROM listing_events');
          db.exec(`DELETE FROM sync_state WHERE key LIKE 'bigquery:%'`);
          db.exec('DELETE FROM metric_cache');
        }

        if (connection.has('view_event')) {
          db.exec('ALTER TABLE bigquery_connection DROP COLUMN view_event');
        }
        if (connection.has('click_event')) {
          db.exec('ALTER TABLE bigquery_connection DROP COLUMN click_event');
        }
      }

      const sources = columns(db, 'bigquery_app_sources');
      if (sources.size > 0 && !sources.has('location')) {
        db.exec('ALTER TABLE bigquery_app_sources ADD COLUMN location TEXT');
      }

      // Who a listing event belongs to became a resolved value rather than
      // always the browser cookie. Existing rows keep a blank one and fall back
      // to `anonymous_id` at read time, so no re-sync is needed to keep
      // counting.
      const listing = columns(db, 'listing_events');
      if (listing.size > 0) {
        if (!listing.has('user_key')) {
          db.exec(`ALTER TABLE listing_events ADD COLUMN user_key TEXT NOT NULL DEFAULT ''`);
        }
        // Only once the column is certain to exist. In the schema block this
        // ran before the ALTER above and brought the process down on any
        // database created before the column.
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_listing_events_user
             ON listing_events (app_id, type, user_key)`,
        );
      }
    },
  },

  /*
   * Install intervals learned which event opened them.
   *
   * Separate from migration 1 because it is a separate fact about a separate
   * table: `install_intervals` is derived from the Partner API and would carry
   * this column whether or not a partner ever connects BigQuery. Only the
   * reason for wanting it is shared — a funnel that starts with someone reading
   * the listing must end with someone choosing the app, and a shop that was
   * closed and has reopened chose nothing.
   *
   * The column defaults to 'installed', which is wrong for every interval a
   * reopening opened — and the table is only rewritten by the next sync, so a
   * default left to stand would report reopenings as installs until then. The
   * backfill reads it straight off the raw events the interval was built from:
   * an exact match on the opening timestamp, preferring a real install where a
   * shop somehow carries both at the same instant. Cached figures computed
   * under the old reading go with it.
   */
  {
    version: 2,
    up: (db) => {
      const installs = columns(db, 'install_intervals');
      if (installs.size === 0 || installs.has('started_by')) return;

      db.exec(
        `ALTER TABLE install_intervals ADD COLUMN started_by TEXT NOT NULL DEFAULT 'installed'`,
      );
      db.exec(
        `UPDATE install_intervals AS t
            SET started_by = 'reactivated'
          WHERE EXISTS (SELECT 1 FROM app_events e
                         WHERE e.app_id = t.app_id AND e.shop_id = t.shop_id
                           AND e.occurred_at = t.started_at
                           AND e.type = 'RELATIONSHIP_REACTIVATED')
            AND NOT EXISTS (SELECT 1 FROM app_events e
                             WHERE e.app_id = t.app_id AND e.shop_id = t.shop_id
                               AND e.occurred_at = t.started_at
                               AND e.type = 'RELATIONSHIP_INSTALLED')`,
      );
      db.exec('DELETE FROM metric_cache');
    },
  },
  /*
   * Cursors learned which window they were made for.
   *
   * A Relay cursor is an opaque position inside the result set of the query
   * that issued it, so it is only meaningful to a query with the same
   * arguments. An interrupted pass stores one; the next pass may compute a
   * different `createdAtMin` and hand the old cursor to the new query, which
   * resumes the *old* walk — past the window, through history the pass had no
   * reason to read, and away from the rows it was started for.
   *
   * The column records the window, so the two can be compared and a cursor
   * whose window has moved can be dropped rather than trusted. NULL on every
   * row that predates this, which reads as "unknown window" and therefore as
   * "do not resume" — the safe answer, and it costs one clean re-walk of one
   * window, once.
   */
  {
    version: 3,
    up: (db) => {
      const state = columns(db, 'sync_state');
      if (state.size > 0 && !state.has('cursor_window')) {
        db.exec('ALTER TABLE sync_state ADD COLUMN cursor_window TEXT');
      }
    },
  },
  /*
   * Index work the schema block cannot do, because it names migrated columns.
   *
   * The funnel's own shape: one app, one date range, every bucket.
   * `idx_listing_events_step` is `(app_id, type, occurred_at)`, and the funnel
   * counts both types in a single pass, so `type` sits between the two columns
   * it can actually seek on and the range predicate cannot be used at all —
   * every bucket re-read every event the app has ever collected. Putting
   * `occurred_at` second makes each bucket a range seek, and carrying the two
   * visitor columns keeps it index-only: 1.6s -> 0.04s over 480k events,
   * measured, with identical counts.
   *
   * It names `user_key`, which migration 1 may have only just added, so it
   * cannot live in the schema block — that runs first and would fail on any
   * database predating the column.
   *
   * The two drops remove indexes the schema block has since superseded. Each
   * replacement is a strict extension of the one dropped, so every plan that
   * used the old one still works, and keeping both pays for a second copy of
   * the same keys — hundreds of megabytes on these tables.
   */
  {
    version: 4,
    up: (db) => {
      if (columns(db, 'listing_events').size > 0) {
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_listing_events_window
             ON listing_events (app_id, occurred_at, type, user_key, anonymous_id)`,
        );
      }

      // Superseded by idx_cevents_app_shop_seen.
      db.exec('DROP INDEX IF EXISTS idx_cevents_app_shop');
      // Superseded by idx_tx_type_money.
      db.exec('DROP INDEX IF EXISTS idx_tx_type_time');
    },
  },
  /*
   * Apps learned which Shopify Partner organization they came from.
   *
   * The backfill is the reason this is a migration rather than a schema line.
   * Every app already in this file was synced when only one organization could
   * be configured, so it can only have come from that one. Left blank instead,
   * the first multi-org sync would have apps it cannot pick a token for.
   *
   * The watermarks these apps were synced under are renamed separately, by
   * `namespaceLegacyWatermarks` — that one cannot be a migration. See its own
   * comment.
   */
  {
    version: 5,
    up: (db) => {
      /*
       * The backfill needs an organization to attribute existing rows to, and
       * the environment is the only place that can supply one at this point —
       * the `organizations` table is seeded from it a moment later, and on the
       * database this branch exists for it is empty anyway.
       *
       * Null is possible now that the environment is optional. It means an old
       * database opened by a process that has been given no credentials at all,
       * and the honest response is to add the column and leave it blank rather
       * than attribute millions of rows to a guess. Blank reads as
       * "organization unknown": unscoped reports still count every row, and the
       * apps join no organization's sync until somebody says which one they
       * belong to.
       */
      const primaryOrgId = primaryEnvOrg()?.organizationId ?? '';

      const apps = columns(db, 'apps');
      if (apps.size > 0 && !apps.has('org_id')) {
        db.exec(`ALTER TABLE apps ADD COLUMN org_id TEXT NOT NULL DEFAULT ''`);
        if (primaryOrgId) {
          db.prepare(`UPDATE apps SET org_id = ? WHERE org_id = ''`).run(primaryOrgId);
        }
      }

      // Unconditional and idempotent, outside the guard above and deliberately
      // so: inside it a *new* database would never get the index, because its
      // table arrives with the column already present and the branch never
      // runs. And not in the schema block, because that runs before this and
      // would name a column an old database lacks.
      if (columns(db, 'apps').size > 0) {
        db.exec('CREATE INDEX IF NOT EXISTS idx_apps_org ON apps (org_id)');
      }
    },
  },
];

export function readUserVersion(db: Db): number {
  return (db.pragma('user_version', { simple: true }) as number) ?? 0;
}

/**
 * Apply every migration whose version is greater than the database's current
 * user_version. Idempotent: a caught-up database runs zero migrations.
 *
 * `extra` is a test seam — production callers leave it undefined so only
 * MIGRATIONS runs. Tests pass a temporary migration (or a throwing one) without
 * polluting the production list.
 */
export function migrate(db: Db, extra: Migration[] = []): void {
  const current = readUserVersion(db);
  const pending = [...MIGRATIONS, ...extra]
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}

/**
 * Namespace the watermark keys that predate organizations, once an
 * organization is known.
 *
 * Deliberately *not* a migration, and this is the whole point of it. Keys used
 * to be `transactions:all` / `transactions:<appId>` / `events:<appId>`, which
 * name no organization; two orgs sharing `transactions:all` would take turns
 * pushing each other's watermark forward and each would then skip the range the
 * other had already claimed — a silent gap, not a crash. The new keys are
 * `org:<orgId>:...`, and renaming the existing ones rather than letting them
 * fall out of use is what stops a completed multi-hour backfill restarting from
 * `SYNC_START_DATE`.
 *
 * A migration runs once and is then recorded as done. But the rename needs an
 * organization, and the environment may not have one yet: an old database
 * opened by a process with no credentials would have taken its one turn and
 * skipped it, stranding hours of backfill under keys nothing reads. Run on
 * every open and guarded on the legacy rows still being there, it is
 * idempotent, it does nothing on the overwhelmingly common path where there are
 * none, and it self-heals on the first open that does have an organization.
 *
 * `reviews:` and `bigquery:` keys are deliberately untouched — they are keyed
 * by app id, and app ids are globally unique across organizations.
 */
export function namespaceLegacyWatermarks(db: Db): void {
  const primaryOrgId = primaryEnvOrg()?.organizationId;
  if (!primaryOrgId) return;

  const legacy = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sync_state
        WHERE key LIKE 'transactions:%' OR key LIKE 'events:%'`,
    )
    .get() as { n: number };
  if (legacy.n === 0) return;

  db.transaction(() => {
    // Defensive, and cheap: a legacy key whose namespaced counterpart somehow
    // already exists would make the UPDATE below a primary-key collision and
    // take the boot down. The namespaced row is the newer of the two, so the
    // legacy one goes.
    db.prepare(
      `DELETE FROM sync_state
        WHERE (key LIKE 'transactions:%' OR key LIKE 'events:%')
          AND EXISTS (SELECT 1 FROM sync_state other
                       WHERE other.key = 'org:' || ? || ':' || sync_state.key)`,
    ).run(primaryOrgId);

    // `sync_state` is WITHOUT ROWID with `key` as its primary key, and an
    // UPDATE of a primary key simply rewrites the row.
    db.prepare(
      `UPDATE sync_state
          SET key = 'org:' || ? || ':' || key
        WHERE key LIKE 'transactions:%' OR key LIKE 'events:%'`,
    ).run(primaryOrgId);
  })();
}
