import type { AcquisitionChannel, FunnelAcquisition, MatchMethod } from '../api';
import { formatValue } from '../format';
import { InfoTip } from './InfoTip';

/**
 * Where the range's installs came from.
 *
 * Every install in the range is a row's worth of it — the rows add up to the
 * funnel's "Installed" step. Rows with a source come first, and last the
 * installs nothing could place, with what those merchants paid, rather than
 * dropping out and leaving the rest to read as the whole.
 */

function share(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

function percent(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

function count(value: number): string {
  return formatValue(value, 'count', null);
}

/** What the two unplaced rows are called, and the one-line reason under each. */
const UNPLACED: Record<'no_visit' | 'not_recorded', { label: string; detail: string }> = {
  no_visit: {
    label: 'No listing visit recorded',
    detail: 'Google Analytics saw the install, but not a listing visit from the same browser.',
  },
  not_recorded: {
    label: 'Installed outside the tracked listing',
    detail: 'No Google Analytics activity around the install — typically installed from inside the Shopify admin.',
  },
};

const METHOD_LABEL: Record<MatchMethod, string> = {
  ga4: 'GA4 cookie',
  timing: 'click timing',
};

/**
 * How a row's installs were placed, said only when it is not simply "GA4".
 *
 * Most rows are GA4 all the way down, and a caption on every one of them would
 * be noise. It earns its place where a row mixes evidence, or rests on
 * something other than the cookie match.
 */
function matchCaption(channel: AcquisitionChannel): string | null {
  const parts = (Object.keys(METHOD_LABEL) as MatchMethod[])
    .filter((method) => channel.matchedBy[method] > 0)
    .map((method) => `${count(channel.matchedBy[method])} ${METHOD_LABEL[method]}`);
  if (parts.length === 0) return null;
  if (parts.length === 1 && channel.matchedBy.ga4 > 0) return null;
  return `by ${parts.join(' · ')}`;
}

function rowClass(channel: AcquisitionChannel, firstOfGroup: boolean): string | undefined {
  const classes: string[] = [];
  if (channel.kind === 'no_visit' || channel.kind === 'not_recorded') classes.push('acquisition-unplaced');
  if (firstOfGroup) classes.push('acquisition-group-first');
  return classes.length > 0 ? classes.join(' ') : undefined;
}

export function Acquisition({ data }: { data: FunnelAcquisition }) {
  const widest = Math.max(...data.channels.map((channel) => channel.installs), 1);

  if (data.installs === 0) {
    return (
      <div className="card full acquisition-card">
        <div className="card-head">
          <span className="card-label">Where installs came from</span>
        </div>
        <p className="acquisition-empty">No installs in this range.</p>
      </div>
    );
  }

  const placedBy = (['ga4', 'timing'] as MatchMethod[])
    .filter((method) => data.matchedBy[method] > 0)
    .map((method) => `${count(data.matchedBy[method])} by ${METHOD_LABEL[method]}`);

  return (
    <div className="card full acquisition-card">
      <div className="card-head">
        <span className="card-label">
          Where installs came from
          <InfoTip label="Where installs came from">
            Every install in the range, by the most recent listing visit with a known source in the 30 days before
            it. A visit is tied to an install by the browser’s Google Analytics cookie, or failing that by the one
            “Add app” click in the minute before the install. App Store search and browsing show as “shopify app
            store”, with the search term as the campaign; the Shopify admin’s app search as “shopify admin”.
          </InfoTip>
        </span>
      </div>

      <div className="table-wrap">
        <table className="acquisition-table">
          <thead>
            <tr>
              <th scope="col">Source / medium</th>
              <th scope="col">
                Installs
                <InfoTip label="Installs">Shops in this row, and their share of every install in the range.</InfoTip>
              </th>
              <th scope="col">
                Paying
                <InfoTip label="Paying">
                  Of those shops, how many paid something after installing — a priced plan or a usage charge — and
                  what share that is. A free plan is not paying.
                </InfoTip>
              </th>
              <th scope="col">
                MRR now
                <InfoTip label="MRR now">
                  MRR these shops carry today, made up the same way as the MRR card: plan prices plus the usage
                  charges your reporting settings count. Shops that have since cancelled add nothing.
                </InfoTip>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.channels.map((channel, index) => {
              const previous = data.channels[index - 1];
              const groupOf = (kind: AcquisitionChannel['kind']) => (kind === 'not_recorded' ? 'no_visit' : kind);
              const firstOfGroup = index > 0 && previous !== undefined && groupOf(previous.kind) !== groupOf(channel.kind);
              const caption = matchCaption(channel);

              let heading;
              if (channel.kind === 'no_visit' || channel.kind === 'not_recorded') {
                const unplaced = UNPLACED[channel.kind];
                heading = (
                  <>
                    <span className="acquisition-source">{unplaced.label}</span>
                    <span className="acquisition-campaigns">{unplaced.detail}</span>
                  </>
                );
              } else {
                heading = (
                  <>
                    <span className="acquisition-source">
                      {channel.source} <span className="acquisition-medium">/ {channel.medium}</span>
                    </span>
                    {channel.campaigns.length > 0 ? (
                      <span className="acquisition-campaigns" title={channel.campaigns.join(', ')}>
                        {channel.campaigns.slice(0, 3).join(', ')}
                        {channel.campaigns.length > 3 ? ` +${channel.campaigns.length - 3}` : ''}
                      </span>
                    ) : null}
                  </>
                );
              }

              return (
                <tr key={`${channel.kind} ${channel.source} ${channel.medium}`} className={rowClass(channel, firstOfGroup)}>
                  <th scope="row">{heading}</th>
                  <td>
                    <span className="acquisition-figure">{count(channel.installs)}</span>
                    <span className="acquisition-track" aria-hidden="true">
                      <span className="acquisition-bar" style={{ width: `${(channel.installs / widest) * 100}%` }} />
                    </span>
                    <span className="acquisition-share">{percent(share(channel.installs, data.installs))}</span>
                    {caption ? <span className="acquisition-matched">{caption}</span> : null}
                  </td>
                  <td>
                    {count(channel.paying)}
                    <span className="acquisition-share">{percent(share(channel.paying, channel.installs))}</span>
                  </td>
                  <td>{formatValue(channel.mrr, 'money', data.currency)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {data.ga4.length > 0 ? (
        <details className="acquisition-compare">
          <summary>Compare with Google Analytics</summary>
          <p className="acquisition-compare-note">
            Google Analytics’ <em>Traffic acquisition</em> report, by session source / medium for the{' '}
            <code>shopify_app_install</code> event, and where those installs sit in the table above. Google labels most
            App Store traffic “(direct)” or “(not set)”; this table reads the listing page behind it. Google counts
            install events in its own timezone, so its totals can differ from these by a few at the edges of the range.
          </p>
          <div className="table-wrap">
            <table className="acquisition-table">
              <thead>
                <tr>
                  <th scope="col">In Google Analytics</th>
                  <th scope="col">Installs</th>
                  <th scope="col">Here</th>
                </tr>
              </thead>
              <tbody>
                {data.ga4.map((row) => (
                  <tr key={row.ga4}>
                    <th scope="row">
                      <span className="acquisition-source">{row.ga4}</span>
                    </th>
                    <td>{count(row.installs)}</td>
                    <td className="acquisition-compare-here">
                      {row.here.length === 1 && row.here[0]!.label === row.ga4
                        ? 'Same'
                        : row.here.map((entry) => `${entry.label} ${count(entry.installs)}`).join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}

      <p className="acquisition-coverage">
        {count(data.traced)} of {count(data.installs)} installs ({percent(share(data.traced, data.installs))}) are
        tied to a listing visit{placedBy.length > 0 ? ` — ${placedBy.join(', ')}` : ''}. The rows add up to the
        funnel’s “Installed” step.
      </p>
    </div>
  );
}
