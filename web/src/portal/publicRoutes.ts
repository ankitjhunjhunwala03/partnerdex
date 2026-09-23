/**
 * The two portal routes that exist outside a session, as one definition.
 *
 * `#/set-password/<token>` and `#/signup`, the second of which may name one
 * program as `#/signup/<programId>`.
 *
 * This is a module rather than a parser inside `PortalApp` because the invite
 * link has two ends and they are in different bundles: the admin's programs
 * page builds the URL, and the portal reads it. Two hand-written spellings of
 * the same route is a pair that agrees until one of them is edited, and the
 * failure it produces — an invite link that lands on the generic signup form
 * with nothing preselected — looks exactly like a working link to whoever sent
 * it. So both ends call in here, and `signupHash` is the only thing that writes
 * the shape `parsePublicRoute` reads.
 *
 * The hash carries these rather than the path because the portal is one static
 * bundle served from `/portal`, so there are no server-side paths to route on.
 *
 * The two second segments are separate fields rather than one shared string,
 * because they are not the same kind of value. A set-password token is a
 * credential that is spent and must never be rendered; a program id is public,
 * goes in a link an operator posts, and is shown back to the applicant. One
 * field holding either is how the first ends up somewhere only the second was
 * safe.
 */
export type PublicRoute =
  | { route: 'set-password'; token: string }
  | { route: 'signup'; programId: string }
  | { route: null };

/**
 * Read a location hash. Anything that is not one of the two is `null`, which
 * the shell treats as "carry on to the session check" — an unknown hash must
 * never be a third unauthenticated page.
 */
export function parsePublicRoute(hash: string): PublicRoute {
  const raw = hash.replace(/^#\/?/, '');
  const [name, second] = raw.split('/');

  if (name === 'set-password' && second) {
    return { route: 'set-password', token: decodeURIComponent(second) };
  }

  if (name === 'signup') {
    // No second segment is the general form — the page listing every open
    // program — and is what a bare `#/signup` has always meant. It stays valid:
    // every link already handed out has that shape.
    return { route: 'signup', programId: second ? decodeURIComponent(second) : '' };
  }

  return { route: null };
}

/**
 * The hash an invite link carries, and the only place its shape is written.
 *
 * Encoded because the id is put in a path segment. Today every program id is a
 * UUID and the encoding is a no-op; ids imported from another system are not
 * ours to make promises about, and a `/` inside one would otherwise mint a link
 * that parses as a different route entirely.
 */
export function signupHash(programId?: string): string {
  return programId ? `#/signup/${encodeURIComponent(programId)}` : '#/signup';
}

/**
 * The whole invite URL, given where the portal lives.
 *
 * Takes the base rather than reading one, so the two decisions stay apart: what
 * the link *is* belongs here, next to the parser that reads it back; which host
 * to name is the caller's, because only the admin side knows about
 * `PORTAL_BASE_URL` and what to do when it is unset.
 */
export function signupUrl(baseUrl: string, programId?: string): string {
  return `${baseUrl}/portal${signupHash(programId)}`;
}
