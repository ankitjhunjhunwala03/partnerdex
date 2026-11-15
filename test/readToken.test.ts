import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { ConfigError, getConfig, resetConfig } from '../src/config.js';
import { createApp } from '../src/server/index.js';
import { resetEnvironment } from './helpers.js';

/**
 * The read-only token, over a real socket for the same reason as `auth.test.ts`:
 * what has to hold is which routes it reaches once everything is mounted, and
 * that is a property of the assembled app rather than of the middleware.
 *
 * The cases are the ways a second credential usually goes wrong: it opens more
 * than it was meant to, it works as the first credential, or it is accepted
 * when nobody configured it.
 */

const PASSWORD = 'correct-horse-battery';
const TOKEN = 'a'.repeat(16) + 'b'.repeat(16) + 'c'.repeat(16);

let server: Server;
let origin: string;

const call = (path: string, init: RequestInit = {}): Promise<Response> => fetch(`${origin}${path}`, init);
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const withToken = (path: string, method = 'GET'): Promise<Response> => call(path, { method, headers: bearer(TOKEN) });

before(async () => {
  resetEnvironment({ DASHBOARD_PASSWORD: PASSWORD, API_READ_TOKEN: TOKEN });
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

describe('the read-only API token', () => {
  it('reads the report routes', async () => {
    for (const path of ['/api/apps', '/api/metrics']) {
      assert.equal((await withToken(path)).status, 200, `${path} should be readable`);
    }
    // These depend on what the store holds, so the assertion is only that the
    // gate let the request through to the handler.
    for (const path of [
      '/api/overview?metrics=mrr',
      '/api/metrics/mrr',
      '/api/funnel',
      '/api/funnel/apps',
    ]) {
      const { status } = await withToken(path);
      assert.ok(status !== 401 && status !== 403, `${path} was stopped at the gate with ${status}`);
    }
  });

  it('is refused everything that is not a report, with a reason', async () => {
    for (const path of [
      '/api/customers',
      '/api/customers/123',
      '/api/status',
      '/api/reviews',
      '/api/notifications',
      '/api/bigquery',
      '/api/affiliates',
      '/api/organizations',
      '/api/listings',
    ]) {
      const response = await withToken(path);
      assert.equal(response.status, 403, `${path} must not be readable with the token`);
      assert.equal((await response.json()).error, 'This token can only read reports.');
    }
  });

  it('cannot write, even to a route it may read', async () => {
    for (const [path, method] of [
      ['/api/sync', 'POST'],
      ['/api/funnel', 'POST'],
      ['/api/apps', 'DELETE'],
      ['/api/bigquery/check', 'POST'],
    ] as const) {
      assert.equal((await withToken(path, method)).status, 403, `${method} ${path} must be refused`);
    }
  });

  it('does not reach past a report route by path tricks', async () => {
    for (const path of ['/api/metrics/mrr/extra', '/api/metrics/..%2Fcustomers', '/api/funnel/apps/x', '/api/appsx']) {
      const { status } = await withToken(path);
      assert.equal(status, 403, `${path} must not match the allow-list`);
    }
  });

  it('refuses a wrong, shortened or lengthened token as unauthenticated', async () => {
    for (const token of [`${TOKEN.slice(0, -1)}x`, TOKEN.slice(0, -1), `${TOKEN}x`, PASSWORD]) {
      assert.equal((await call('/api/apps', { headers: bearer(token) })).status, 401);
    }
    assert.equal((await call('/api/apps', { headers: { authorization: TOKEN } })).status, 401);
    assert.equal((await call('/api/apps', { headers: { authorization: `Basic ${TOKEN}` } })).status, 401);
  });

  it('is not a session: it does not work as the cookie or log anyone in', async () => {
    assert.equal((await call('/api/apps', { headers: { cookie: `partnerdex_session=${TOKEN}` } })).status, 401);
    const session = await call('/api/auth/session', { headers: bearer(TOKEN) });
    assert.deepEqual(await session.json(), { required: true, authenticated: false });
    const login = await call('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: TOKEN }),
    });
    assert.equal(login.status, 401);
  });

  it('leaves the session cookie able to do everything it could before', async () => {
    const login = await call('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    assert.equal((await call('/api/status', { headers: { cookie } })).status, 200);
    assert.equal((await call('/api/customers', { headers: { cookie } })).status, 200);
  });
});

describe('read-only token configuration', () => {
  // Each case re-reads the environment; the server above is not touched because
  // it resolved its configuration when it was built — these assert on
  // `getConfig` directly and restore the suite's values afterwards.
  const restore = (): void => {
    process.env.API_READ_TOKEN = TOKEN;
    resetConfig();
  };

  it('accepts no token when none is configured', () => {
    process.env.API_READ_TOKEN = '';
    resetConfig();
    assert.equal(getConfig().auth.readToken, null);
    restore();
  });

  it('refuses to start with a token short enough to guess', () => {
    process.env.API_READ_TOKEN = 'short-token';
    resetConfig();
    assert.throws(() => getConfig(), (error: unknown) => error instanceof ConfigError && /API_READ_TOKEN must be at least 32/.test(error.message));
    restore();
  });
});
