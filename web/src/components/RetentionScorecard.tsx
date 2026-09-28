import type { ChartSeries, RetentionCurveData } from './Chart';
import { formatValue } from '../format';

/** The three days a reader asks about: gone at once, gone in the first fortnight, gone in a quarter. */
const MILESTONES = [1, 15, 90] as const;

/** Per-plan uninstall counts from the response's band rows, keyed like the curves. */
interface BandRow {
  key: string;
  withinDay: number;
  within15: number;
  within90: number;
}

/** How many of a plan's installs had uninstalled by each milestone. */
function leftBy(row: BandRow | undefined, day: (typeof MILESTONES)[number]): number {
  if (!row) return 0;
  if (day === 1) return row.withinDay;
  if (day === 15) return row.withinDay + row.within15;
  return row.withinDay + row.within15 + row.within90;
}

/**
 * Retention as figures: one row per plan, the share still installed on day 1,
 * 15 and 90 with a bar on a shared 0–100% scale, and under each the number of
 * installs that had left by then. Every plan is listed, largest first.
 *
 * A rate resting on only a few installs is still shown — hiding it hid the plan
 * — but muted, with how many it rests on in its tooltip, so a 100% from two
 * installs does not read like a 100% from two hundred.
 */
export function RetentionScorecard({
  curves,
  overall,
  rows,
  series,
  fewInstalls,
}: {
  curves: RetentionCurveData[];
  overall?: RetentionCurveData;
  rows: BandRow[];
  series: ChartSeries[];
  fewInstalls: number;
}) {
  if (curves.length === 0) return <p className="card-note">No installs in this range.</p>;

  const color = new Map(series.map((item) => [item.key, item.color]));
  const bands = new Map(rows.map((row) => [row.key, row]));
  const allBands: BandRow = rows.reduce(
    (sum, row) => ({
      key: 'all',
      withinDay: sum.withinDay + row.withinDay,
      within15: sum.within15 + row.within15,
      within90: sum.within90 + row.within90,
    }),
    { key: 'all', withinDay: 0, within15: 0, within90: 0 },
  );

  const line = (curve: RetentionCurveData, band: BandRow | undefined, total = false) => (
    <tr key={curve.key} className={total ? 'scorecard-total' : undefined}>
      <th scope="row">
        <span className="scorecard-plan">
          {total ? null : (
            <span className="legend-swatch" style={{ background: color.get(curve.key) }} aria-hidden />
          )}
          <span>
            <span className="scorecard-name">{curve.planName}</span>
            {curve.appName ? <span className="scorecard-app">{curve.appName}</span> : null}
          </span>
        </span>
      </th>
      <td className="scorecard-installs">{formatValue(curve.installs, 'count', null)}</td>
      {MILESTONES.map((day) => {
        const point = curve.points[day];
        const value = point?.retained ?? null;
        const left = leftBy(band, day);
        if (value === null) {
          return (
            <td key={day} className="scorecard-rate">
              <span className="scorecard-pending" title="No install in this plan has been around this long yet">
                —
              </span>
              <span className="scorecard-left">{formatValue(left, 'count', null)} left</span>
            </td>
          );
        }
        const few = (point?.eligible ?? 0) < fewInstalls;
        return (
          <td
            key={day}
            className={few ? 'scorecard-rate scorecard-few' : 'scorecard-rate'}
            title={few ? `Based on only ${point?.eligible} install${point?.eligible === 1 ? '' : 's'} old enough to reach day ${day}` : undefined}
          >
            <span className="scorecard-figure">{Math.round(value)}%</span>
            <span className="scorecard-track" aria-hidden>
              <span className="scorecard-bar" style={{ width: `${value}%` }} />
            </span>
            <span className="scorecard-left">
              {formatValue(left, 'count', null)} left{few ? ' · few installs' : ''}
            </span>
          </td>
        );
      })}
    </tr>
  );

  return (
    <div className="table-wrap">
      <table className="scorecard">
        <thead>
          <tr>
            <th scope="col">Plan</th>
            <th scope="col" className="scorecard-installs">
              Installs
            </th>
            {MILESTONES.map((day) => (
              <th scope="col" key={day}>
                Day {day}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{curves.map((curve) => line(curve, bands.get(curve.key)))}</tbody>
        {overall ? <tfoot>{line(overall, allBands, true)}</tfoot> : null}
      </table>
    </div>
  );
}
