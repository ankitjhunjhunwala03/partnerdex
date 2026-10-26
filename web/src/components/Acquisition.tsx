import type { FunnelAcquisition } from '../api';
import { formatValue } from '../format';
import { InfoTip } from './InfoTip';

/**
 * Where the range's installs came from.
 *
 * One row per source / medium, credited from the listing visit GA4 could join
 * to each install. The coverage line is not decoration: every install that
 * could not be joined is missing from every row, so without it a small channel
 * reads as a real figure rather than a sample of one.
 */

function share(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

function percent(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

export function Acquisition({ data }: { data: FunnelAcquisition }) {
  const coverage = share(data.traced, data.installs);
  const widest = Math.max(...data.channels.map((channel) => channel.installs), 1);

  return (
    <div className="card full acquisition-card">
      <div className="card-head">
        <span className="card-label">
          Where installs came from
          <InfoTip label="Where installs came from">
            Each install is credited to the most recent listing visit with a known source in the 30 days before it,
            using the source and medium Google Analytics gave that visit. Where Google has none, visits from the App
            Store’s own search and pages show as “shopify app store”, with the search term as the campaign. A direct
            visit only counts when there is nothing else.
          </InfoTip>
        </span>
      </div>

      {data.traced === 0 ? (
        <p className="acquisition-empty">
          {data.tracked === 0
            ? 'Google Analytics has not recorded any installs in this range yet. They are collected on the next BigQuery sync.'
            : `Google Analytics recorded ${formatValue(data.tracked, 'count', null)} install(s) in this range, but none could be matched to a listing visit.`}
        </p>
      ) : (
        <div className="table-wrap">
          <table className="acquisition-table">
            <thead>
              <tr>
                <th scope="col">Source / medium</th>
                <th scope="col">
                  Installs
                  <InfoTip label="Installs">
                    Shops credited to this source, with their share of all installs that could be traced.
                  </InfoTip>
                </th>
                <th scope="col">
                  Paying
                  <InfoTip label="Paying">
                    Of those shops, how many paid something after installing — a priced plan or a usage charge —
                    and what share that is. A free plan is not paying.
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
              {data.channels.map((channel) => {
                const of = share(channel.installs, data.traced);
                return (
                  <tr key={`${channel.source} ${channel.medium}`}>
                    <th scope="row">
                      <span className="acquisition-source">
                        {channel.source} <span className="acquisition-medium">/ {channel.medium}</span>
                      </span>
                      {channel.campaigns.length > 0 ? (
                        <span className="acquisition-campaigns" title={channel.campaigns.join(', ')}>
                          {channel.campaigns.slice(0, 3).join(', ')}
                          {channel.campaigns.length > 3 ? ` +${channel.campaigns.length - 3}` : ''}
                        </span>
                      ) : null}
                    </th>
                    <td>
                      <span className="acquisition-figure">{formatValue(channel.installs, 'count', null)}</span>
                      <span className="acquisition-track" aria-hidden="true">
                        <span
                          className="acquisition-bar"
                          style={{ width: `${(channel.installs / widest) * 100}%` }}
                        />
                      </span>
                      <span className="acquisition-share">{percent(of)}</span>
                    </td>
                    <td>
                      {formatValue(channel.paying, 'count', null)}
                      <span className="acquisition-share">
                        {percent(share(channel.paying, channel.installs))}
                      </span>
                    </td>
                    <td>{formatValue(channel.mrr, 'money', data.currency)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="acquisition-coverage">
        {formatValue(data.traced, 'count', null)} of {formatValue(data.installs, 'count', null)} installs could be
        traced to a source{coverage === null ? '' : ` (${percent(coverage)})`}. The rest installed on a different
        device from the one that visited the listing, blocked analytics, or reached the app without visiting it, so
        treat these rows as a sample.
      </p>
    </div>
  );
}
