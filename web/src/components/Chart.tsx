import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MetricFormat } from '../api';
import { formatBucketDate, formatFullDate, formatValue } from '../format';

/**
 * The plot primitives every card draws with.
 *
 * Grid and axis are drawn in the theme's low-contrast scaffolding roles, so the
 * data reads and the frame recedes — and both follow the surface when the theme
 * flips, since nothing here names a colour directly.
 *
 * A legend is rendered by the card whenever there is more than one series, and
 * those cards also carry a table view: four slots is past the point where colour
 * alone identifies a series, whatever its contrast. A single-series card needs
 * neither — its title names the series.
 */

export interface ChartSeries {
  key: string;
  name: string;
  /** A CSS custom property reference, so the theme swap is automatic. */
  color: string;
}

export type ChartDatum = { date: string } & Record<string, number | string>;

/**
 * Extras for a table that is a ledger rather than a sample of a series: a row
 * totalling each column over the whole window, signs coloured so a loss reads as
 * one, and one column carried at full weight because the others add up to it.
 *
 * Opt-in, because neither makes sense by default. Totalling a level across
 * twelve months produces a figure with no meaning, and a table whose values are
 * all positive gains nothing from colouring them.
 */
export interface LedgerOptions {
  totalLabel: string;
  /** Series key drawn at full weight — the column the others sum to. */
  emphasize?: string;
}

export function DataTable({
  series,
  data,
  format,
  currency,
  interval,
  ledger,
}: {
  series: ChartSeries[];
  data: ChartDatum[];
  format: MetricFormat;
  currency: string | null;
  interval: string;
  ledger?: LedgerOptions;
}) {
  const cellClass = (key: string, value: number): string | undefined => {
    if (!ledger) return undefined;
    const classes = [];
    if (key === ledger.emphasize) classes.push('cell-emphasis');
    // Zero is neither, and saying so keeps a quiet month from reading as a
    // gain: an empty column is not the same fact as money arriving.
    if (value < 0) classes.push('cell-down');
    else if (value > 0) classes.push('cell-up');
    return classes.length > 0 ? classes.join(' ') : undefined;
  };

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Period</th>
            {series.map((item) => (
              <th scope="col" key={item.key} className={item.key === ledger?.emphasize ? 'cell-emphasis' : undefined}>
                {item.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.date}>
              <th scope="row">{formatBucketDate(row.date, interval)}</th>
              {series.map((item) => {
                const value = Number(row[item.key] ?? 0);
                return (
                  <td key={item.key} className={cellClass(item.key, value)}>
                    {formatValue(value, format, currency)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        {ledger ? (
          <tfoot>
            <tr>
              <th scope="row">{ledger.totalLabel}</th>
              {series.map((item) => {
                const total = data.reduce((sum, row) => sum + Number(row[item.key] ?? 0), 0);
                return (
                  <td key={item.key} className={cellClass(item.key, total)}>
                    {formatValue(total, format, currency)}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

/**
 * A composition read at one instant: each part, what it contributes, and what
 * share of the whole that is.
 *
 * Unlike `DataTable` this is not a time series — the rows are the parts, not the
 * buckets. A stock split by category has one honest reading, the level at the
 * end of the range, and laying twelve months of it across a table asks the
 * reader to find that column themselves.
 */
interface ShareRow extends ChartSeries {
  value: number;
}

/**
 * The parts of a composition, read at the end of the range and ordered largest
 * first. Shared by the two views of a share card so the chart and the table can
 * never be showing different rows or a different order.
 */
function shareRows(series: ChartSeries[], data: ChartDatum[]): ShareRow[] {
  const latest = data.at(-1);
  return series
    .map((item) => ({ ...item, value: Number(latest?.[item.key] ?? 0) }))
    .sort((a, b) => b.value - a.value);
}

/** Long category names need room; past this they are cut and the tooltip carries the rest. */
function clip(label: string, chars: number): string {
  return label.length > chars ? `${label.slice(0, chars - 1)}…` : label;
}

/**
 * A category label on two lines, subject first.
 *
 * These labels are hierarchical — "App · Plan" — and the app half repeats down
 * the whole axis while the plan half is the only thing telling one row from
 * another. Set as one truncated string it read "AIOD Discount & Gift · AIOD C…"
 * four times over: every row identical, identity gone, which is the one thing an
 * axis label exists to carry. So the discriminator goes on the first line in
 * secondary ink and the shared prefix underneath it in muted, smaller — present
 * for the case where two apps sell a plan of the same name, quiet enough not to
 * crowd out the name that matters.
 */
function CategoryTick({
  x,
  y,
  payload,
}: {
  x?: number;
  y?: number;
  payload?: { value?: string | number };
}) {
  const label = String(payload?.value ?? '');
  const at = label.indexOf(' · ');
  const [prefix, subject] = at === -1 ? [null, label] : [label.slice(0, at), label.slice(at + 3)];
  const left = x ?? 0;
  const top = y ?? 0;

  return (
    <text textAnchor="end" x={left} y={top}>
      <tspan x={left - 8} dy={prefix ? -1 : 4} fill="var(--text-secondary)" fontSize={11}>
        {clip(subject, 34)}
      </tspan>
      {prefix ? (
        <tspan x={left - 8} dy={11} fill="var(--muted)" fontSize={9.5}>
          {clip(prefix, 32)}
        </tspan>
      ) : null}
    </text>
  );
}

function ShareBarTooltip({
  active,
  payload,
  format,
  currency,
  total,
  valueLabel,
}: {
  active?: boolean;
  payload?: Array<{ payload?: ShareRow }>;
  format: MetricFormat;
  currency: string | null;
  total: number;
  valueLabel: string;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;

  return (
    <div className="tooltip">
      {/* The full name, untruncated — the axis had to cut it, this does not. */}
      <div className="tooltip-date">{row.name}</div>
      <div className="tooltip-row">
        <span className="name">{valueLabel}</span>
        <span className="value">{formatValue(row.value, format, currency)}</span>
      </div>
      <div className="tooltip-row">
        <span className="name">Share</span>
        <span className="value">
          {total === 0 ? '—' : `${((row.value / total) * 100).toFixed(1)}%`}
        </span>
      </div>
    </div>
  );
}

/**
 * The same composition as `ShareTable`, drawn.
 *
 * Horizontal bars, because the categories are many and their names are long —
 * a plan carries its app's name in front of it when more than one app is in
 * scope, which no column header would fit. Sorted descending, so the reader's
 * question ("which tier carries the business?") is answered by the top row
 * before any figure is read.
 *
 * One hue for every bar, not a colour per category. Bar length already encodes
 * the value and the axis label already carries the identity, so a second
 * channel would be spending the categorical palette to repeat what the chart
 * says twice — and with a dozen plans in the table there is no honest set of
 * hues to spend. This is also what lets the chart show *every* row, the same
 * ones the table lists, instead of folding a tail into "Other" to stay inside
 * four colour slots.
 */
export function ShareBars({
  series,
  data,
  format,
  currency,
  valueLabel,
}: {
  series: ChartSeries[];
  data: ChartDatum[];
  format: MetricFormat;
  currency: string | null;
  /** The same column name the table view uses, so the two views agree. */
  valueLabel?: string;
}) {
  const rows = shareRows(series, data);
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  // One band per row at a fixed rhythm, so ten plans and thirty both read at the
  // same density instead of being squeezed into a height chosen in advance. Two
  // lines of label need the taller band.
  const twoLine = rows.some((row) => row.name.includes(' · '));
  const height = Math.max(rows.length * (twoLine ? 34 : 28) + 28, 120);

  if (rows.length === 0) return null;

  return (
    <div className="plot" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 84, bottom: 0, left: 0 }}>
          <XAxis
            type="number"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            tickCount={4}
            tickFormatter={axisFormatter(format, currency)}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={215}
            tick={<CategoryTick />}
            tickLine={false}
            axisLine={{ stroke: 'var(--axis)' }}
            // Every row gets its label. Left to itself Recharts drops ticks to
            // avoid collisions, which on this chart means dropping the name of a
            // plan the reader can still see a bar for.
            interval={0}
          />
          <Tooltip
            cursor={{ fill: 'var(--hover-wash)' }}
            content={
              <ShareBarTooltip
                format={format}
                currency={currency}
                total={total}
                valueLabel={valueLabel ?? (format === 'money' ? 'MRR' : 'Value')}
              />
            }
          />
          <Bar
            dataKey="value"
            fill="var(--series-1)"
            barSize={18}
            // Rounded at the data end, square where it meets the baseline.
            radius={[0, 4, 4, 0]}
            isAnimationActive={false}
          >
            {/* Full precision, per the house rule that only axis ticks compact:
                a label at the tip is something the reader reads. */}
            <LabelList
              dataKey="value"
              position="right"
              fill="var(--text-secondary)"
              fontSize={11}
              formatter={(value: number) => formatValue(value, format, currency)}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ShareTable({
  series,
  data,
  format,
  currency,
  partLabel,
  totalLabel,
  valueLabel,
}: {
  series: ChartSeries[];
  data: ChartDatum[];
  format: MetricFormat;
  currency: string | null;
  partLabel: string;
  totalLabel: string;
  /** Names the measure when neither "MRR" nor "Value" is what the column holds. */
  valueLabel?: string;
}) {
  const rows = shareRows(series, data);
  const total = rows.reduce((sum, row) => sum + row.value, 0);

  // Share of nothing is not zero, it is undefined — an empty range says nothing
  // about how the parts divide, and printing 0.0% would claim it did.
  const share = (value: number): string =>
    total === 0 ? '—' : `${((value / total) * 100).toFixed(1)}%`;

  return (
    /* Three columns stretched across a full-width card strand the figures at the
       far edge, and the eye loses the row on the way over. The table keeps its
       natural width and the rest of the card stays empty. */
    <div className="table-wrap share-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">{partLabel}</th>
            <th scope="col">{valueLabel ?? (format === 'money' ? 'MRR' : 'Value')}</th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.name}</th>
              <td>{formatValue(row.value, format, currency)}</td>
              <td className="cell-share">{share(row.value)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">{totalLabel}</th>
            <td>{formatValue(total, format, currency)}</td>
            <td className="cell-share">{total === 0 ? '—' : '100.0%'}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

interface TooltipPayloadEntry {
  dataKey?: string | number;
  value?: number;
}

function SeriesTooltip({
  active,
  payload,
  label,
  series,
  format,
  currency,
  showTotal,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
  series: ChartSeries[];
  format: MetricFormat;
  currency: string | null;
  showTotal: boolean;
}) {
  if (!active || !payload?.length) return null;

  const total = payload.reduce((sum, entry) => sum + (entry.value ?? 0), 0);

  return (
    <div className="tooltip">
      <div className="tooltip-date">{label ? formatFullDate(label) : ''}</div>
      {payload.map((entry) => {
        const match = series.find((item) => item.key === entry.dataKey);
        if (!match) return null;
        return (
          <div className="tooltip-row" key={match.key}>
            <span className="name">
              <span className="legend-swatch" style={{ background: match.color }} />
              {match.name}
            </span>
            <span className="value">{formatValue(entry.value ?? 0, format, currency)}</span>
          </div>
        );
      })}
      {showTotal && payload.length > 1 ? (
        <div className="tooltip-row total">
          <span className="name">Total</span>
          <span className="value">{formatValue(total, format, currency)}</span>
        </div>
      ) : null}
    </div>
  );
}

const AXIS_TICK = { fill: 'var(--muted)', fontSize: 10 } as const;
const MARGIN = { top: 6, right: 6, bottom: 0, left: 0 } as const;

interface PlotProps {
  data: ChartDatum[];
  series: ChartSeries[];
  format: MetricFormat;
  currency: string | null;
  interval: string;
  /** Cards run short so three fit a row; the breakdown card runs taller. */
  height?: number;
}

function axisFormatter(format: MetricFormat, currency: string | null) {
  return (value: number) => formatValue(value, format, currency, { compact: true });
}

function sharedAxes(format: MetricFormat, currency: string | null, interval: string) {
  return (
    <>
      <CartesianGrid stroke="var(--grid)" strokeDasharray="0" vertical={false} />
      <XAxis
        dataKey="date"
        tick={AXIS_TICK}
        tickLine={false}
        axisLine={{ stroke: 'var(--axis)' }}
        tickFormatter={(value: string) => formatBucketDate(value, interval)}
        minTickGap={30}
      />
      <YAxis
        tick={AXIS_TICK}
        tickLine={false}
        axisLine={false}
        width={52}
        tickCount={4}
        tickFormatter={axisFormatter(format, currency)}
      />
    </>
  );
}

function Frame({ height, children }: { height: number; children: React.ReactElement }) {
  return (
    <div className="plot" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

/** Stacked composition over time — the shape of MRR split by app. */
export function StackedAreaPlot({
  data,
  series,
  format,
  currency,
  interval,
  height = 150,
}: PlotProps) {
  return (
    <Frame height={height}>
      <AreaChart data={data} margin={MARGIN}>
        {sharedAxes(format, currency, interval)}
        <Tooltip
          cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }}
          content={<SeriesTooltip series={series} format={format} currency={currency} showTotal />}
        />
        {series.map((item) => (
          <Area
            key={item.key}
            type="monotone"
            dataKey={item.key}
            stackId="stack"
            stroke="var(--surface-1)"
            // A 2px card-coloured edge reads as a gap, so adjacent bands in a
            // stack separate by shape and not only by hue.
            strokeWidth={2}
            fill={item.color}
            fillOpacity={0.9}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </Frame>
  );
}

/** Flow metrics: money or counts that accumulate inside each bucket. */
export function BarPlot({ data, series, format, currency, interval, height = 150 }: PlotProps) {
  return (
    <Frame height={height}>
      <BarChart data={data} margin={MARGIN}>
        {sharedAxes(format, currency, interval)}
        <Tooltip
          cursor={{ fill: 'var(--hover-wash)' }}
          content={<SeriesTooltip series={series} format={format} currency={currency} showTotal />}
        />
        {series.map((item, index) => (
          <Bar
            key={item.key}
            dataKey={item.key}
            stackId="stack"
            fill={item.color}
            stroke="var(--surface-1)"
            strokeWidth={2}
            // Rounded ends belong on the top of the stack only.
            radius={index === series.length - 1 ? [4, 4, 0, 0] : undefined}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </Frame>
  );
}

/** Stock metrics and rates: a level read at each point in time. */
export function LinePlot({ data, series, format, currency, interval, height = 150 }: PlotProps) {
  return (
    <Frame height={height}>
      <LineChart data={data} margin={MARGIN}>
        {sharedAxes(format, currency, interval)}
        <Tooltip
          cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }}
          content={
            <SeriesTooltip series={series} format={format} currency={currency} showTotal={false} />
          }
        />
        {series.map((item) => (
          <Line
            key={item.key}
            type="monotone"
            dataKey={item.key}
            stroke={item.color}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface-1)' }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </Frame>
  );
}

/** Turns the API's per-series arrays into the row shape Recharts consumes. */
export function useChartData(
  seriesData: Array<{ key: string; data: Array<{ date: string; value: number }> }>,
): ChartDatum[] {
  return useMemo(() => {
    const rows = new Map<string, ChartDatum>();
    for (const series of seriesData) {
      for (const point of series.data) {
        const row = rows.get(point.date) ?? ({ date: point.date } as ChartDatum);
        row[series.key] = point.value;
        rows.set(point.date, row);
      }
    }
    return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [seriesData]);
}
