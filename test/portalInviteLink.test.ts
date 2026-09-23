import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { parsePublicRoute, signupHash, signupUrl } from '../web/src/portal/publicRoutes.js';

/**
 * The invite link, from the end that mints it to the end that reads it.
 *
 * Worth a test for one reason: the two ends are in different bundles and the
 * failure between them is silent. An admin copies a link, a partner opens it,
 * and a drifted route renders the generic signup form with nothing preselected
 * — which looks like a working page to the partner and like a sent link to the
 * operator. Nothing raises, nothing 404s, and the first sign of trouble is a
 * partner enrolled in the wrong program at the wrong rate.
 *
 * So the round trip is asserted rather than either half.
 */

describe('the program invite link', () => {
  it('parses back into the program it named', () => {
    const programId = randomUUID();
    assert.deepEqual(parsePublicRoute(signupHash(programId)), {
      route: 'signup',
      programId,
    });
  });

  it('survives the whole URL an operator copies out of the dashboard', () => {
    const programId = randomUUID();
    const url = signupUrl('https://partners.example.com', programId);

    assert.equal(url, `https://partners.example.com/portal#/signup/${programId}`);

    // What the browser hands the portal is the hash of that URL, not the URL.
    assert.deepEqual(parsePublicRoute(new URL(url).hash), { route: 'signup', programId });
  });

  it('keeps the bare signup page, which is what every existing link is', () => {
    // Links already handed out have no program in them and must keep working:
    // the page lists every open program and the applicant chooses.
    assert.deepEqual(parsePublicRoute('#/signup'), { route: 'signup', programId: '' });
    assert.deepEqual(parsePublicRoute(signupHash()), { route: 'signup', programId: '' });
  });

  it('does not let an id break out of its path segment', () => {
    // Every id in the ledger today is a UUID, so this encoding is a no-op on
    // real data. Ids imported from another system are not ours to promise
    // anything about, and an unencoded slash would mint a link that parses as
    // a different route.
    const hash = signupHash('a/b');
    assert.equal(hash, '#/signup/a%2Fb');
    assert.deepEqual(parsePublicRoute(hash), { route: 'signup', programId: 'a/b' });
  });

  it('still reads a set-password link, and keeps it out of the program field', () => {
    const token = randomUUID();
    assert.deepEqual(parsePublicRoute(`#/set-password/${token}`), {
      route: 'set-password',
      token,
    });
  });

  it('treats anything else as no public route at all', () => {
    // An unknown hash must fall through to the session check rather than
    // becoming a third page a stranger can open.
    for (const hash of ['', '#/', '#/overview', '#/signups', '#/set-password']) {
      assert.deepEqual(parsePublicRoute(hash), { route: null }, hash);
    }
  });
});
