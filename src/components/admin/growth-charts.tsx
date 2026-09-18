"use client";

import { useId, useMemo, useState } from "react";
import { formatRate } from "@/lib/format-rate";
import { cn } from "@/lib/utils";

/**
 * Interactive time-series charts for `/admin/growth`.
 *
 * Same contract as `charts.tsx`, which this sits beside rather than inside only because
 * that file is the Money section's:
 *
 *   1. EVERY VALUE IS REACHABLE WITHOUT HOVERING. A time series with ninety buckets cannot
 *      print ninety numbers without becoming noise, so instead each legend chip carries its
 *      series' latest value and every chart has a table toggle that prints all of them.
 *      Hover adds a readout; it never holds the only copy of a number.
 *   2. THE Y-AXIS STARTS AT ZERO. It scales to the largest *visible* value — hiding MAU to
 *      read DAU is the point of the legend toggles — but never to the data's range, so one
 *      signup stays a sliver and never becomes a cliff.
 *   3. ONE AXIS PER PLOT. Two measures of different scale (running total against new
 *      signups, viewers against page views) are two stacked plots sharing an x-axis and a
 *      crosshair, never one plot with a second scale.
 *
 * NO MEASURING. Bars, gridlines, dots and labels are HTML positioned in percentages; only
 * the lines are SVG, drawn into a stretched viewBox with non-scaling strokes. The server
 * and the client render the same markup, nothing waits on a ResizeObserver, and the chart
 * still draws in a hidden or zero-sized pane — where anything measured would read as 0.
 *
 * CLIENT COMPONENT THAT TOUCHES NO SERVER CODE. Props are plain serialisable data — no
 * formatter functions, which cannot cross the server/client boundary — and the only import
 * beyond React is the dependency-free `format-rate.ts`.
 */

/* --------------------------------------------------------------------- types -------- */

export type ChartSeries = {
  key: string;
  label: string;
  /** A CSS colour, normally `var(--series-N)`. Fixed per entity, never per rank. */
  color: string;
  /** One per bucket. `null` is "not measured yet", drawn as a gap — never as zero. */
  values: Array<number | null>;
  /** Hidden until switched on from the legend. */
  defaultHidden?: boolean;
  /**
   * Readout shows "5 of 9" against this, plus a percentage once `formatRate` allows it.
   * Used by the retention curves, where the denominator is the cohort's size.
   */
  denominator?: number;
};

export type ChartPlot = {
  /** Caption above the plot when a chart stacks several. */
  title?: string;
  mark: "line" | "bar" | "stacked";
  series: ChartSeries[];
  /** Pixel height of the plot area. */
  height?: number;
  /** Decimal places for values and ticks; ratios use 1. */
  decimals?: number;
};

type ReadoutNote = { label: string; value: string };

export type TimeSeriesChartProps = {
  /** Short x-axis label per bucket. */
  labels: string[];
  /** Readout heading per bucket, e.g. "Week of 8 Sep". */
  titles: string[];
  plots: ChartPlot[];
  /** Pre-formatted extra readout lines per bucket (the server already knows them). */
  notes?: ReadoutNote[][];
  /** The final bucket is still in progress: drawn fainter and flagged in the readout. */
  partialLast?: boolean;
  /**
   * `select` turns the legend into a picker: one series is drawn in colour and the rest
   * recede to grey. For many series of one kind (cohorts), where eight hues would be noise
   * and the reader wants one line against the rest.
   */
  emphasis?: "select";
  /** Which series `emphasis` starts on. Defaults to the last one. */
  defaultSelected?: string;
  /** Replaces the chart when every value is zero or missing. */
  emptyLabel: string;
  /** Summary for screen readers — the plot itself is presentational. */
  ariaLabel: string;
  /** Column heading for the bucket column of the table view. */
  bucketHeading?: string;
};

/* ------------------------------------------------------------------- helpers -------- */

/**
 * A zero-anchored axis with round ticks: 1, 2 or 5 × 10ⁿ per step, at most four steps.
 * Integer charts never get a fractional tick — "2.5 accounts" is not a thing.
 */
function axis(maxValue: number, decimals: number) {
  const unit = decimals > 0 ? 10 ** -decimals : 1;
  const target = Math.max(maxValue, unit) / 4;
  const pow = 10 ** Math.floor(Math.log10(target));
  const step = Math.max(
    unit,
    [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= target - 1e-9) ?? 10 * pow
  );
  const max = Math.max(step, Math.ceil(maxValue / step - 1e-9) * step);
  const ticks: number[] = [];
  for (let t = 0; t <= max + 1e-9; t += step) ticks.push(Number(t.toFixed(6)));
  return { max, ticks };
}

function fmt(value: number, decimals = 0) {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtValue(series: ChartSeries, value: number | null, decimals = 0) {
  if (value == null) return "—";
  if (series.denominator != null) return formatRate(value, series.denominator);
  return fmt(value, decimals);
}

/** The most recent measured value, for the legend chip. */
function latest(values: Array<number | null>) {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return values[i];
  return null;
}

/**
 * At most ~7 x labels, evenly spaced and always including the last bucket, so a 90-day
 * daily chart reads as dates rather than a smear of digits.
 */
function tickIndexes(n: number) {
  if (n <= 8) return Array.from({ length: n }, (_, i) => i);
  const every = Math.ceil(n / 7);
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i -= every) out.unshift(i);
  return out;
}

/* ----------------------------------------------------------------- component -------- */

export function TimeSeriesChart({
  labels,
  titles,
  plots,
  notes,
  partialLast = false,
  emphasis,
  defaultSelected,
  emptyLabel,
  ariaLabel,
  bucketHeading = "Period",
}: TimeSeriesChartProps) {
  const n = labels.length;
  const allSeries = useMemo(() => plots.flatMap((p) => p.series), [plots]);

  const [hidden, setHidden] = useState<Set<string>>(
    () => new Set(allSeries.filter((s) => s.defaultHidden).map((s) => s.key))
  );
  const [selected, setSelected] = useState<string | null>(
    emphasis === "select" ? (defaultSelected ?? allSeries.at(-1)?.key ?? null) : null
  );
  const [preview, setPreview] = useState<string | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();

  const isEmpty = allSeries.every((s) => s.values.every((v) => !v));
  if (n === 0 || isEmpty) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  const focus = preview ?? selected;
  const visible = (s: ChartSeries) => emphasis === "select" || !hidden.has(s.key);

  const toggle = (key: string) =>
    setHidden((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      // Never hide the last visible series: an empty plot looks like a data outage.
      else if (allSeries.filter((s) => !next.has(s.key)).length > 1) next.add(key);
      return next;
    });

  const move = (delta: number) =>
    setActive((cur) => Math.min(n - 1, Math.max(0, (cur ?? n - 1) + delta)));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") move(-1);
    else if (e.key === "ArrowRight") move(1);
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(n - 1);
    else if (e.key === "Escape") setActive(null);
    else return;
    e.preventDefault();
  };

  const onPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const i = Math.floor(((e.clientX - rect.left) / rect.width) * n);
    setActive(Math.min(n - 1, Math.max(0, i)));
  };

  const xPct = (i: number) => ((i + 0.5) / n) * 100;
  const ticksAt = tickIndexes(n);
  const multi = allSeries.length > 1;

  return (
    <div>
      {/* Legend: one row, toggles (or a picker under `emphasis`), each chip carrying its
          series' latest value so the headline number is on screen without hovering. */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        {multi &&
          allSeries.map((s) => {
            const on = emphasis === "select" ? focus === s.key : !hidden.has(s.key);
            const mark = plots.find((p) => p.series.includes(s))?.mark ?? "line";
            const last = latest(s.values);
            const decimals = plots.find((p) => p.series.includes(s))?.decimals ?? 0;
            return (
              <button
                key={s.key}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  emphasis === "select" ? setSelected(s.key) : toggle(s.key)
                }
                onPointerEnter={() => emphasis === "select" && setPreview(s.key)}
                onPointerLeave={() => emphasis === "select" && setPreview(null)}
                onFocus={() => emphasis === "select" && setPreview(s.key)}
                onBlur={() => emphasis === "select" && setPreview(null)}
                className={cn(
                  "flex items-center gap-1.5 rounded text-xs transition-opacity duration-fast focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  on ? "text-foreground" : "text-muted-foreground opacity-60"
                )}
              >
                <span
                  aria-hidden
                  className={cn(mark === "line" ? "h-0.5 w-3.5 rounded-full" : "size-2.5 rounded-[3px]")}
                  style={{
                    background:
                      emphasis === "select" && !on ? "var(--muted-foreground)" : s.color,
                  }}
                />
                {s.label}
                {last != null && (
                  <span className="tabular-nums text-muted-foreground">
                    {fmtValue(s, last, decimals)}
                  </span>
                )}
              </button>
            );
          })}
        <button
          type="button"
          aria-expanded={showTable}
          aria-controls={tableId}
          onClick={() => setShowTable((v) => !v)}
          className="ml-auto rounded text-xs text-muted-foreground underline-offset-2 transition-colors duration-fast hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {showTable ? "Hide table" : "Show table"}
        </button>
      </div>

      {showTable ? (
        <DataTable
          id={tableId}
          titles={titles}
          plots={plots}
          partialLast={partialLast}
          bucketHeading={bucketHeading}
        />
      ) : (
        <div
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onBlur={() => setActive(null)}
          className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {plots.map((plot, pi) =>
            // A plot whose every series is switched off collapses rather than drawing an
            // empty grid, which would read as "nothing happened".
            plot.series.some(visible) ? (
              <Plot
                key={pi}
                plot={plot}
                n={n}
                active={active}
                focus={emphasis === "select" ? focus : null}
                visible={visible}
                partialLast={partialLast}
                xPct={xPct}
                onPointer={onPointer}
                onLeave={() => setActive(null)}
                spaced={plots.slice(0, pi).some((p) => p.series.some(visible))}
              />
            ) : null
          )}

          {/* X labels, once, under the last plot — every plot shares the axis. */}
          <div className="relative ml-10 mt-1.5 h-4" aria-hidden>
            {ticksAt.map((i) => (
              <span
                key={i}
                className={cn(
                  "absolute top-0 -translate-x-1/2 whitespace-nowrap text-[0.625rem] tabular-nums transition-colors",
                  active === i ? "text-foreground" : "text-muted-foreground"
                )}
                style={{ left: `${xPct(i)}%` }}
              >
                {labels[i]}
              </span>
            ))}
          </div>

          <Readout
            index={active}
            titles={titles}
            plots={plots}
            notes={notes}
            visible={visible}
            focus={emphasis === "select" ? focus : null}
            partial={partialLast && active === n - 1}
          />
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- plot -------- */

function Plot({
  plot,
  n,
  active,
  focus,
  visible,
  partialLast,
  xPct,
  onPointer,
  onLeave,
  spaced,
}: {
  plot: ChartPlot;
  n: number;
  active: number | null;
  focus: string | null;
  visible: (s: ChartSeries) => boolean;
  partialLast: boolean;
  xPct: (i: number) => number;
  onPointer: (e: React.PointerEvent<HTMLDivElement>) => void;
  onLeave: () => void;
  spaced: boolean;
}) {
  const height = plot.height ?? 180;
  const decimals = plot.decimals ?? 0;
  const shown = plot.series.filter(visible);

  let maxValue = 0;
  for (let i = 0; i < n; i++) {
    const values = shown.map((s) => s.values[i] ?? 0);
    const tall =
      plot.mark === "stacked" ? values.reduce((a, b) => a + b, 0) : Math.max(0, ...values);
    maxValue = Math.max(maxValue, tall);
  }

  const { max, ticks } = axis(maxValue, decimals);
  const y = (v: number) => (v / max) * 100; // percent of plot height, from the bottom

  return (
    <div className={cn(spaced && "mt-4")}>
      {plot.title && (
        <div className="mb-1.5 ml-10 text-[0.6875rem] font-medium text-muted-foreground">
          {plot.title}
        </div>
      )}
      {/* Top margin: the highest tick label is centred on the plot's top edge. */}
      <div className="mt-2 flex">
        {/* Y ticks */}
        <div className="relative w-10 shrink-0" style={{ height }} aria-hidden>
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute right-2 translate-y-1/2 text-[0.625rem] tabular-nums text-muted-foreground"
              style={{ bottom: `${y(t)}%` }}
            >
              {fmt(t, t % 1 === 0 ? 0 : decimals)}
            </span>
          ))}
        </div>

        <div
          className="relative min-w-0 flex-1 touch-pan-y"
          style={{ height }}
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onPointerLeave={onLeave}
        >
          {/* Gridlines: solid hairlines, one shade off the surface. */}
          {ticks.map((t) => (
            <span
              key={t}
              aria-hidden
              className={cn(
                "absolute inset-x-0 h-px",
                t === 0 ? "bg-border" : "bg-border/50"
              )}
              style={{ bottom: `${y(t)}%` }}
            />
          ))}

          {/* Hover band for bar charts; hairline crosshair for lines. */}
          {active != null &&
            (plot.mark === "line" ? (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 w-px bg-foreground/25"
                style={{ left: `${xPct(active)}%` }}
              />
            ) : (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 bg-muted/60"
                style={{ left: `${(active / n) * 100}%`, width: `${100 / n}%` }}
              />
            ))}

          {plot.mark !== "line" && (
            <Bars
              plot={plot}
              shown={shown}
              n={n}
              y={y}
              height={height}
              partialLast={partialLast}
            />
          )}

          {plot.mark === "line" && (
            <Lines
              shown={shown}
              n={n}
              y={y}
              xPct={xPct}
              focus={focus}
              partialLast={partialLast}
              active={active}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Bars({
  plot,
  shown,
  n,
  y,
  height,
  partialLast,
}: {
  plot: ChartPlot;
  shown: ChartSeries[];
  n: number;
  y: (v: number) => number;
  height: number;
  partialLast: boolean;
}) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {Array.from({ length: n }, (_, i) => {
        const segments = (plot.mark === "stacked" ? shown : shown.slice(0, 1))
          .map((s) => ({ s, v: s.values[i] ?? 0 }))
          .filter((x) => x.v > 0);
        return (
          <div
            key={i}
            className={cn(
              "absolute bottom-0 flex flex-col-reverse items-center",
              partialLast && i === n - 1 && "opacity-50"
            )}
            style={{ left: `${(i / n) * 100}%`, width: `${100 / n}%`, height }}
          >
            {segments.map(({ s, v }, si) => (
              <span
                key={s.key}
                className={cn(
                  "w-[62%] max-w-7 transition-[height] duration-slow ease-house",
                  si === segments.length - 1 && "rounded-t-[3px]"
                )}
                style={{
                  height: `${y(v)}%`,
                  background: s.color,
                  // A 2px surface gap between stacked segments, never a drawn border.
                  borderTop:
                    si < segments.length - 1 ? "2px solid var(--card)" : undefined,
                }}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function Lines({
  shown,
  n,
  y,
  xPct,
  focus,
  partialLast,
  active,
}: {
  shown: ChartSeries[];
  n: number;
  y: (v: number) => number;
  xPct: (i: number) => number;
  focus: string | null;
  partialLast: boolean;
  active: number | null;
}) {
  // Draw focused series last so it sits on top of the grey ones.
  const ordered = focus
    ? [...shown.filter((s) => s.key !== focus), ...shown.filter((s) => s.key === focus)]
    : shown;

  /** Path segments broken at nulls, so "not measured" is a gap rather than a dive to 0. */
  const paths = (values: Array<number | null>, from: number, to: number) => {
    let d = "";
    let pen = false;
    for (let i = from; i <= to; i++) {
      const v = values[i];
      if (v == null) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${xPct(i)} ${100 - y(v)} `;
      pen = true;
    }
    return d.trim();
  };

  const colorOf = (s: ChartSeries) =>
    focus && s.key !== focus ? "var(--muted-foreground)" : s.color;
  const faded = (s: ChartSeries) => Boolean(focus && s.key !== focus);

  return (
    <>
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0 size-full overflow-visible"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        {ordered.map((s) => {
          const lastFull = partialLast ? n - 2 : n - 1;
          return (
            <g key={s.key} opacity={faded(s) ? 0.35 : 1}>
              <path
                d={paths(s.values, 0, lastFull)}
                fill="none"
                stroke={colorOf(s)}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              {/* The bucket still in progress: same line, fainter — it will rise. */}
              {partialLast && n > 1 && (
                <path
                  d={paths(s.values, n - 2, n - 1)}
                  fill="none"
                  stroke={colorOf(s)}
                  strokeWidth={2}
                  strokeOpacity={0.4}
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </g>
          );
        })}
      </svg>

      {/* Markers as HTML so they stay round in the stretched viewBox: the active point on
          every visible line, and a single point when a series has only one value. */}
      {ordered.map((s) =>
        s.values.map((v, i) => {
          if (v == null) return null;
          const lonely = s.values[i - 1] == null && s.values[i + 1] == null;
          if (i !== active && !lonely) return null;
          return (
            <span
              key={`${s.key}-${i}`}
              aria-hidden
              className="pointer-events-none absolute size-2 -translate-x-1/2 translate-y-1/2 rounded-full ring-2 ring-card"
              style={{
                left: `${xPct(i)}%`,
                bottom: `${y(v)}%`,
                background: colorOf(s),
                opacity: faded(s) ? 0.5 : 1,
              }}
            />
          );
        })
      )}
    </>
  );
}

/* ------------------------------------------------------------------- readout -------- */

/**
 * The hover readout, pinned under the plot rather than floating by the pointer: it never
 * covers the line being read, never overflows a phone screen, and holds its height so the
 * page does not jump as the pointer moves.
 */
function Readout({
  index,
  titles,
  plots,
  notes,
  visible,
  focus,
  partial,
}: {
  index: number | null;
  titles: string[];
  plots: ChartPlot[];
  notes?: ReadoutNote[][];
  visible: (s: ChartSeries) => boolean;
  focus: string | null;
  partial: boolean;
}) {
  return (
    <div
      aria-live="polite"
      className="mt-3 min-h-[2.75rem] rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs"
    >
      {index == null ? (
        <span className="text-muted-foreground">
          Hover or tap the chart for a breakdown; arrow keys step through it.
        </span>
      ) : (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 tabular-nums">
          <span className="font-medium">
            {titles[index]}
            {partial && (
              <span className="ml-1 font-normal text-muted-foreground">(in progress)</span>
            )}
          </span>
          {plots.flatMap((plot) =>
            plot.series.filter(visible).map((s) => (
              <span
                key={s.key}
                className={cn(
                  "flex items-center gap-1.5",
                  focus && s.key !== focus && "text-muted-foreground"
                )}
              >
                <span
                  aria-hidden
                  className="h-0.5 w-3 rounded-full"
                  style={{
                    background: focus && s.key !== focus ? "var(--muted-foreground)" : s.color,
                  }}
                />
                {s.values[index] == null ? (
                  // Only the retention curves have gaps: that cohort has not lived
                  // through this week yet, which is not the same as nobody returning.
                  <span className="italic text-muted-foreground">not reached</span>
                ) : (
                  <strong className="font-medium text-foreground">
                    {fmtValue(s, s.values[index] ?? null, plot.decimals)}
                  </strong>
                )}
                <span className="text-muted-foreground">{s.label}</span>
              </span>
            ))
          )}
          {notes?.[index]?.map((note) => (
            <span key={note.label} className="text-muted-foreground">
              {note.label} <span className="text-foreground">{note.value}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------- table -------- */

/** Every value the chart draws, as text: the no-hover path to each number. */
function DataTable({
  id,
  titles,
  plots,
  partialLast,
  bucketHeading,
}: {
  id: string;
  titles: string[];
  plots: ChartPlot[];
  partialLast: boolean;
  bucketHeading: string;
}) {
  const cols = plots.flatMap((p) => p.series.map((s) => ({ s, decimals: p.decimals })));
  return (
    <div id={id} className="max-h-80 overflow-auto rounded-lg border border-border/60">
      <table className="w-full text-xs tabular-nums">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b border-border/60 text-muted-foreground">
            <th scope="col" className="px-3 py-2 text-left font-medium">
              {bucketHeading}
            </th>
            {cols.map(({ s }) => (
              <th key={s.key} scope="col" className="px-3 py-2 text-right font-medium">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* Newest first: the row you came for is the top one. */}
          {titles
            .map((title, i) => ({ title, i }))
            .reverse()
            .map(({ title, i }) => (
              <tr key={i} className="border-b border-border/40 last:border-b-0">
                <th scope="row" className="px-3 py-1.5 text-left font-normal">
                  {title}
                  {partialLast && i === titles.length - 1 && (
                    <span className="ml-1 text-muted-foreground">(in progress)</span>
                  )}
                </th>
                {cols.map(({ s, decimals }) => (
                  <td key={s.key} className="px-3 py-1.5 text-right">
                    {fmtValue(s, s.values[i] ?? null, decimals)}
                  </td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
