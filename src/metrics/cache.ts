import { getConfig } from '../config.js';
import type { Db } from '../db/index.js';

/**
 * Read-through cache keyed on the canonical request. The key is the metric plus
 * the normalized query, so two requests that mean the same thing share an
 * entry and one that differs by a single toggle does not.
 *
 * `sync` clears the table wholesale, so a refresh is never served stale data.
 *
 * Generic in the payload because not every report is a time series: the funnel
 * is five steps wide and answers on its own shape, and it wants the same
 * read-through behaviour the metric registry gets.
 */

export function cacheKey(metric: string, query: Record<string, unknown>): string {
  const canonical = Object.keys(query)
    .filter((key) => query[key] !== undefined && query[key] !== '')
    .sort()
    .map((key) => `${key}=${String(query[key])}`)
    .join('&');
  return `${metric}?${canonical}`;
}

export function readCache<T>(db: Db, key: string): T | null {
  const { runtime } = getConfig();
  if (runtime.cacheTtlSeconds <= 0) return null;

  const row = db
    .prepare('SELECT payload, expires_at FROM metric_cache WHERE key = ?')
    .get(key) as { payload: string; expires_at: string } | undefined;

  if (!row) return null;
  if (row.expires_at <= new Date().toISOString()) {
    db.prepare('DELETE FROM metric_cache WHERE key = ?').run(key);
    return null;
  }

  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return null;
  }
}

export function writeCache<T>(db: Db, key: string, response: T): void {
  const { runtime } = getConfig();
  if (runtime.cacheTtlSeconds <= 0) return;

  const expiresAt = new Date(Date.now() + runtime.cacheTtlSeconds * 1000).toISOString();
  db.prepare(
    `INSERT INTO metric_cache (key, payload, expires_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at`,
  ).run(key, JSON.stringify(response), expiresAt);
}
