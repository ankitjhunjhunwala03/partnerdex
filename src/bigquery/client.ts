import { BigQueryError, readConnection, type BigQueryConnection } from './connection.js';

/**
 * The thin layer between this project and `@google-cloud/bigquery`.
 *
 * Two jobs. It builds a client from the credential in the database rather than
 * from ambient application-default credentials, because the whole point of the
 * settings page is that an instance nobody can redeploy can still be pointed at
 * a different project. And it turns Google's errors into ones a partner can act
 * on: "table not found" for a GA4 export that has not been enabled reads as an
 * internal failure otherwise, and it is the single most likely thing to be
 * wrong on a first connection.
 */

interface QueryRow {
  [column: string]: unknown;
}

interface BigQueryLike {
  query(options: {
    query: string;
    params?: Record<string, unknown>;
    types?: Record<string, unknown>;
    location?: string;
    maximumBytesBilled?: string;
  }): Promise<[QueryRow[]]>;
}

type BigQueryConstructor = new (options: {
  projectId: string;
  credentials: Record<string, unknown>;
}) => BigQueryLike;

/**
 * A ceiling on a single query, in bytes. GA4 exports are wide and daily-sharded,
 * and a mistyped date range is a full-table scan of every day the property has
 * ever recorded. BigQuery rejects the job rather than billing for it.
 */
const MAX_BYTES_BILLED = String(20 * 1024 * 1024 * 1024); // 20 GiB

let constructorPromise: Promise<BigQueryConstructor> | null = null;

/**
 * Loaded on demand, not at import.
 *
 * `@google-cloud/bigquery` pulls in a large dependency tree, and an install that
 * never connects BigQuery — which is every install until someone fills in the
 * settings page — should not pay to load it on boot. It also means a missing
 * package degrades to one clear message on one page instead of a server that
 * will not start.
 */
async function bigQueryConstructor(): Promise<BigQueryConstructor> {
  if (!constructorPromise) {
    constructorPromise = import('@google-cloud/bigquery')
      .then((module) => module.BigQuery as unknown as BigQueryConstructor)
      .catch(() => {
        constructorPromise = null;
        throw new BigQueryError(
          'The @google-cloud/bigquery package is not installed. Run `npm install` and restart.',
          500,
        );
      });
  }
  return constructorPromise;
}

export interface Connected {
  client: BigQueryLike;
  connection: BigQueryConnection;
}

export async function connect(connection?: BigQueryConnection | null): Promise<Connected> {
  const resolved = connection ?? readConnection();
  if (!resolved) {
    throw new BigQueryError('BigQuery is not connected. Add a connection in Settings.', 409);
  }

  const BigQuery = await bigQueryConstructor();
  const credentials = JSON.parse(resolved.credentials) as Record<string, unknown>;
  return {
    client: new BigQuery({ projectId: resolved.projectId, credentials }),
    connection: resolved,
  };
}

/**
 * Rewrites the handful of Google errors that have a specific, actionable cause
 * into that cause. Anything else is passed through with its own message, which
 * is usually already the clearest account of what happened.
 */
export function explain(error: unknown, context: { dataset?: string } = {}): BigQueryError {
  if (error instanceof BigQueryError) return error;

  const message = error instanceof Error ? error.message : String(error);
  const dataset = context.dataset ? `\`${context.dataset}\`` : 'the dataset';

  if (/Not found: (Dataset|Table)/i.test(message)) {
    return new BigQueryError(
      `${dataset} was not found. Check the dataset name, that its location matches the one set ` +
        'here, and that BigQuery Link is turned on in the GA4 property (Admin → Product links → ' +
        'BigQuery Links).',
      404,
    );
  }
  if (/Permission .* denied|does not have bigquery|accessDenied/i.test(message)) {
    return new BigQueryError(
      'The service account cannot read that dataset. Grant it BigQuery Data Viewer on the ' +
        'dataset and BigQuery Job User on the project.',
      403,
    );
  }
  if (/has not been used in project|API has not been enabled|SERVICE_DISABLED/i.test(message)) {
    return new BigQueryError(
      'The BigQuery API is not enabled on that Google Cloud project. Enable it and try again.',
      403,
    );
  }
  if (/quota|rateLimitExceeded|billing/i.test(message)) {
    return new BigQueryError(`BigQuery refused the job: ${message}`, 429);
  }
  if (/invalid_grant|Invalid JWT|unauthorized_client/i.test(message)) {
    return new BigQueryError(
      'Google rejected the service-account key. It may have been revoked or belong to a ' +
        'different project — paste a current key.',
      401,
    );
  }
  // OpenSSL failing to read the PEM, which surfaces as an error code and
  // nothing a reader could act on. It means the key was mangled between the
  // console and the textarea — almost always the newlines in `private_key`.
  if (/DECODER routines|PEM routines|asn1 encoding|no start line/i.test(message)) {
    return new BigQueryError(
      'The private key inside the service-account JSON could not be read. Paste the file exactly ' +
        'as downloaded — the \\n escapes in "private_key" must survive intact.',
      400,
    );
  }
  return new BigQueryError(`BigQuery: ${message}`, 502);
}

/**
 * Runs a query and hands back its rows.
 *
 * Values are always bound as parameters; the only text interpolated into any SQL
 * in this project is a project/dataset identifier that has been through
 * `assertIdentifier`. Hyphens are legal in a Google project id and illegal in a
 * bare BigQuery identifier, which is why every reference is backquoted.
 */
export async function runQuery(
  connected: Connected,
  query: string,
  params: Record<string, unknown> = {},
  options: { location?: string; dataset?: string } = {},
): Promise<QueryRow[]> {
  try {
    const [rows] = await connected.client.query({
      query,
      params,
      // Per call, not per connection: two GA4 properties can export to two
      // regions, and a job sent to the wrong one reports the dataset as missing
      // rather than as misplaced.
      location: options.location ?? connected.connection.location,
      maximumBytesBilled: MAX_BYTES_BILLED,
    });
    return rows;
  } catch (error) {
    throw explain(error, { dataset: options.dataset });
  }
}

/** Test seam: swap the constructor for a stub. */
export function useBigQueryConstructor(constructor: BigQueryConstructor | null): void {
  constructorPromise = constructor ? Promise.resolve(constructor) : null;
}
