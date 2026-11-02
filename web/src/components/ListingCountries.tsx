/**
 * The top of the funnel by country.
 *
 * Steps 1 and 2 — listing views and "Add app" clicks — for the ten countries
 * with the most listing views over the range, then everyone else. A chart of
 * one step at a time over the funnel's own buckets, stacked by country, and a
 * table of the whole range underneath it that doubles as the chart's key.
 *
 * Its own module, and loaded lazily, for the same reason `CardChart` is: the
 * charting library is the heaviest thing the dashboard ships, and the funnel
 * above this card needs none of it.
 */

import { useMemo, useState } from 'react';
import type { FunnelCountry, FunnelResponse } from '../api';
import { formatValue } from '../format';
import { BarPlot, type ChartDatum, type ChartSeries } from './Chart';
import { InfoTip } from './InfoTip';

type Step = 'views' | 'clicks';

/**
 * A named country takes the next categorical slot; the two catch-alls are
 * drawn in the scaffolding greys, so they read as "the rest" rather than as an
 * eleventh and twelfth country.
 */
function colorFor(country: FunnelCountry, index: number): string {
  if (country.kind === 'other') return 'var(--muted)';
  if (country.kind === 'unknown') return 'var(--border)';
  return `var(--series-${index + 1})`;
}

function count(value: number): string {
  return formatValue(value, 'count', null);
}

function share(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 1000) / 10}%` : '—';
}

export default function ListingCountries({ data }: { data: FunnelResponse }) {
  const [step, setStep] = useState<Step>('views');
  const countries = data.countries ?? [];

  // Keyed by position rather than by name: the plot reads a key as a property
  // path, and "St. Kitts & Nevis" is not one.
  const series: ChartSeries[] = useMemo(
    () => countries.map((country, index) => ({ key: `c${index}`, name: country.label, color: colorFor(country, index) })),
    [countries],
  );

  const rows: ChartDatum[] = useMemo(
    () =>
      data.buckets.map((bucket, idx) => {
        const row: ChartDatum = { date: bucket.periodStart };
        countries.forEach((country, index) => {
          row[`c${index}`] = country.byBucket[idx]?.[step] ?? 0;
        });
        return row;
      }),
    [data.buckets, countries, step],
  );

  const totalViews = countries.reduce((sum, country) => sum + country.views, 0);
  const widest = Math.max(...countries.map((country) => country[step]), 1);
  const unknown = countries.find((country) => country.kind === 'unknown');

  return (
    <div className="card full acquisition-card countries-card">
      <div className="card-head">
        <span className="card-label">
          Listing traffic by country
          <InfoTip label="Listing traffic by country">
            The first two funnel steps for the ten countries with the most listing views in the range, from Google
            Analytics’ location for each visitor. Everyone else is under “Other countries”. Each person is counted
            once per country, so a visitor seen in two countries appears in both.
          </InfoTip>
        </span>
        <div className="funnel-views" role="group" aria-label="Which step to chart">
          {(['views', 'clicks'] as Step[]).map((option) => (
            <button
              key={option}
              type="button"
              className={step === option ? 'active' : undefined}
              aria-pressed={step === option}
              onClick={() => setStep(option)}
            >
              {option === 'views' ? 'Views' : 'Clicks'}
            </button>
          ))}
        </div>
      </div>

      {countries.length === 0 ? (
        <p className="acquisition-empty">No listing traffic in this range.</p>
      ) : (
        <>
          <div className="legend">
            {series.map((item) => (
              <span className="legend-item" key={item.key}>
                <span className="legend-swatch" style={{ background: item.color }} />
                {item.name}
              </span>
            ))}
          </div>

          <BarPlot
            data={rows}
            series={series}
            format="count"
            currency={null}
            interval={data.timeSeriesInterval}
            height={240}
          />

          <div className="table-wrap">
            <table className="acquisition-table">
              <thead>
                <tr>
                  <th scope="col">Country</th>
                  <th scope="col">
                    Listing views
                    <InfoTip label="Listing views">
                      Visitors from this country who opened the listing, and their share of all listing visitors.
                    </InfoTip>
                  </th>
                  <th scope="col">
                    Add app clicks
                    <InfoTip label="Add app clicks">Visitors from this country who clicked the install button.</InfoTip>
                  </th>
                  <th scope="col">
                    Click rate
                    <InfoTip label="Click rate">Add app clicks as a share of listing views, within the country.</InfoTip>
                  </th>
                </tr>
              </thead>
              <tbody>
                {countries.map((country, index) => (
                  <tr
                    key={country.key}
                    className={country.kind === 'country' ? undefined : 'acquisition-unplaced'}
                  >
                    <th scope="row">
                      <span className="acquisition-source">
                        <span className="legend-swatch countries-swatch" style={{ background: series[index]!.color }} />
                        {country.label}
                      </span>
                    </th>
                    <td>
                      <span className="acquisition-figure">{count(country.views)}</span>
                      {step === 'views' ? (
                        <span className="acquisition-track" aria-hidden="true">
                          <span
                            className="acquisition-bar"
                            style={{ width: `${(country.views / widest) * 100}%`, background: series[index]!.color }}
                          />
                        </span>
                      ) : null}
                      <span className="acquisition-share">{share(country.views, totalViews)}</span>
                    </td>
                    <td>
                      <span className="acquisition-figure">{count(country.clicks)}</span>
                      {step === 'clicks' ? (
                        <span className="acquisition-track" aria-hidden="true">
                          <span
                            className="acquisition-bar"
                            style={{ width: `${(country.clicks / widest) * 100}%`, background: series[index]!.color }}
                          />
                        </span>
                      ) : null}
                    </td>
                    <td>{share(country.clicks, country.views)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {unknown ? (
            <p className="acquisition-coverage">
              “Unknown” is traffic Google Analytics could not place, plus any synced before countries were collected —
              the next BigQuery sync fills those in.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
