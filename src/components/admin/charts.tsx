"use client";

import { useMemo, useState } from "react";
import { formatCents, formatMicros } from "@/lib/format-money";
import { cn } from "@/lib/utils";

/**
 * Interactive charts for the Money section.
 *
 * WHY THESE EXIST WHEN THE CONSOLE HAS A RULE AGAINST SPARKLINES. The rule is right, and
 * it is more specific than it first reads. `primitives.tsx` states the objection exactly:
 * "a sparkline autoscales, so 0,1,0,0,2 renders as a dramatic spike". The complaint is
 * about autoscaling and unlabelled shapes, not about drawing.
 *
 * So these follow two mechanical rules, both checkable by looking at the output:
 *
 *   1. THE INTEGERS ARE ALWAYS ON SCREEN. Hover adds context; it never reveals a number
 *      that was hidden. A chart whose values live only in a tooltip has made the reader
 *      work for something the page could simply have said.
 *   2. THE Y-AXIS ANCHORS AT ZERO AND NEVER AUTOSCALES TO THE DATA RANGE. One $5
 *      subscriber renders as a $5 sliver on a scale that reaches the month's revenue, not
 *      as a cliff. This is the whole of the objection above.
 *
 * Framed that way these are the labelled-bar idiom `TrendBars` already established, given
 * an axis and something to click.
 *
 * NO CHART LIBRARY, following `network-depth-chart.tsx` and the `TrendTable` docstring's
 * standard ("past ~90 rows this stops working and that is when a chart library earns its
 * place"). Money is read by month; ninety months is not close.
 *
 * CLIENT COMPONENTS THAT TOUCH NO SERVER CODE. Anything here that transitively reached
 * `@/db` would fail the build with a `node:fs` chunking error naming neither file, so
 * every one of these takes plain serialisable props and the queries stay in the page.
 */

/* ------------------------------------------------------------------- helpers -------- */

/** A window selector. Closed set — never interpolated from anything a user typed. */
export function WindowToggle<T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div
      className="flex items-center gap-1 rounded-lg border border-border/70 p-0.5"
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={option.value === value}
          className={cn(
            "rounded-md px-2 py-0.5 text-xs transition-colors",
            option.value === value
              ? "bg-primary/10 text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function LegendSwatch({
  color,
  label,
  on,
  onToggle,
}: {
  color: string;
  label: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      className={cn(
        "flex items-center gap-1.5 text-xs transition-opacity",
        on ? "text-foreground" : "text-muted-foreground opacity-50"
      )}
    >
      <span
        aria-hidden
        className="size-2.5 rounded-[3px]"
        style={{ background: color }}
      />
      {label}
    </button>
  );
}

/* ---------------------------------------------------- revenue against cost ---------- */

export type FlowPoint = {
  label: string;
  /** Cash received, net of refunds. */
  inCents: number;
  outCents: number;
  /** True when no provider bill was entered — drawn hatched, never as a real zero. */
  costMissing?: boolean;
};

/**
 * Money in against money out, with the gap between them shaded.
 *
 * The gap IS the point: contribution is the difference between two bars, and asking a
 * reader to subtract two numbers they can see is worse than shading the space between
 * them. Green where the month made money, red where it did not.
 *
 * A month with no bill entered is hatched rather than drawn at zero. Reporting an unknown
 * cost as $0 produces a month that looks like the most profitable one on the chart.
 */
export function RevenueCostChart({
  points,
  breakEvenCents,
}: {
  points: FlowPoint[];
  /** Fixed monthly cost to clear, drawn as a reference line. */
  breakEvenCents?: number | null;
}) {
  const [showIn, setShowIn] = useState(true);
  const [showOut, setShowOut] = useState(true);
  const [active, setActive] = useState<number | null>(null);

  // Anchored at zero and scaled to the largest value across BOTH series, so the two bars
  // are directly comparable and a small month stays small.
  const max = useMemo(
    () =>
      Math.max(
        1,
        ...points.map((p) => Math.max(p.inCents, p.outCents)),
        breakEvenCents ?? 0
      ),
    [points, breakEvenCents]
  );

  if (points.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        Nothing recorded in this window yet.
      </p>
    );
  }

  const height = 132;
  const scale = (cents: number) => (Math.max(cents, 0) / max) * height;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4">
        <LegendSwatch
          color="var(--chart-2)"
          label="Cash in"
          on={showIn}
          onToggle={() => setShowIn((v) => !v)}
        />
        <LegendSwatch
          color="var(--chart-5)"
          label="Cost out"
          on={showOut}
          onToggle={() => setShowOut((v) => !v)}
        />
        {breakEvenCents != null && breakEvenCents > 0 && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              aria-hidden
              className="h-px w-4 border-t border-dashed border-muted-foreground"
            />
            Break-even {formatCents(breakEvenCents)}
          </span>
        )}
      </div>

      <ol className="flex items-end gap-2" style={{ height: height + 42 }}>
        {points.map((point, i) => {
          const contribution = point.inCents - point.outCents;
          const isActive = active === i;
          const inH = scale(point.inCents);
          const outH = scale(point.outCents);
          const gapTop = Math.max(inH, outH);
          const gapBottom = Math.min(inH, outH);

          return (
            <li
              key={point.label}
              className="flex flex-1 flex-col items-center gap-1"
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
            >
              {/*
                The numbers, unconditionally. Hover only emphasises them.

                A month with no cost entered has no contribution — `in - 0` would print the
                most flattering figure on the chart for the month we know least about.
              */}
              <div
                className={cn(
                  "text-center text-[0.6875rem] leading-tight tabular-nums transition-colors",
                  isActive ? "text-foreground" : "text-muted-foreground"
                )}
              >
                <div>{point.costMissing ? "—" : formatCents(contribution)}</div>
              </div>

              <div
                className="relative w-full"
                style={{ height }}
                role="img"
                aria-label={`${point.label}: ${formatCents(point.inCents)} in, ${
                  point.costMissing ? "no cost entered" : formatCents(point.outCents)
                } out`}
              >
                {/* The contribution gap, shaded between the two bar tops. */}
                {showIn && showOut && !point.costMissing && (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute left-1/2 w-11 -translate-x-1/2 rounded-[2px]",
                      contribution >= 0 ? "bg-chart-2/20" : "bg-destructive/15"
                    )}
                    style={{ bottom: gapBottom, height: Math.max(gapTop - gapBottom, 0) }}
                  />
                )}
                <div className="absolute inset-x-0 bottom-0 flex items-end justify-center gap-1">
                  {showIn && (
                    <span
                      aria-hidden
                      className="w-3 rounded-t-[3px] transition-[height] duration-slow ease-house"
                      style={{ height: inH, background: "var(--chart-2)" }}
                    />
                  )}
                  {showOut && (
                    <span
                      aria-hidden
                      title={point.costMissing ? "No bill entered" : undefined}
                      className={cn(
                        "w-3 rounded-t-[3px] transition-[height] duration-slow ease-house",
                        // Full height at low opacity, because an unentered cost is not a
                        // small cost — it is an unknown one, and it could be anything up to
                        // and past the top of this chart. Drawing a stub would read as
                        // "cheap month"; drawing it solid would read as "expensive month".
                        // A faint column spanning the whole range says neither.
                        point.costMissing && "opacity-25"
                      )}
                      style={{
                        height: point.costMissing ? height : outH,
                        background: point.costMissing
                          ? "repeating-linear-gradient(45deg, var(--muted-foreground) 0 2px, transparent 2px 5px)"
                          : "var(--chart-5)",
                      }}
                    />
                  )}
                </div>
                {breakEvenCents != null && breakEvenCents > 0 && (
                  <span
                    aria-hidden
                    className="absolute inset-x-0 border-t border-dashed border-muted-foreground/60"
                    style={{ bottom: scale(breakEvenCents) }}
                  />
                )}
              </div>

              <div
                className={cn(
                  "text-center text-[0.625rem] leading-tight transition-colors",
                  isActive ? "text-foreground" : "text-muted-foreground"
                )}
              >
                {point.label}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="mt-3 min-h-[2.5rem] rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs">
        {active == null ? (
          <span className="text-muted-foreground">
            Hover a month for its breakdown. Bars are on one zero-anchored scale, so a
            small month looks small.
          </span>
        ) : (
          <span className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
            <strong className="font-medium">{points[active]!.label}</strong>
            <span>In {formatCents(points[active]!.inCents)}</span>
            <span>
              Out{" "}
              {points[active]!.costMissing
                ? "not entered"
                : formatCents(points[active]!.outCents)}
            </span>
            {points[active]!.costMissing ? (
              <span className="text-muted-foreground">
                Contribution unknown until the bill is entered
              </span>
            ) : (
              <span
                className={
                  points[active]!.inCents - points[active]!.outCents >= 0
                    ? "text-foreground"
                    : "text-destructive"
                }
              >
                Contribution{" "}
                {formatCents(points[active]!.inCents - points[active]!.outCents)}
              </span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- distribution --------- */

export type DistributionPoint = {
  label: string;
  activeUsers: number;
  p50: number;
  p90: number;
  max: number;
};

/**
 * Per-user spend as a spread, not a single number.
 *
 * A mean would report one power user at fifty times the median as a mild uptick. The bar
 * runs from the median to the 90th percentile with the maximum marked beyond it, so the
 * shape of the tail is the thing you actually see.
 */
export function DistributionChart({
  points,
  format = formatMicros,
}: {
  points: DistributionPoint[];
  format?: (value: number) => string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const max = useMemo(
    () => Math.max(1, ...points.map((p) => p.max)),
    [points]
  );

  if (points.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        No usage recorded in this window.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-[3px] bg-chart-3" />
          median to p90
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-3 w-px bg-chart-5" />
          heaviest account
        </span>
      </div>

      <ol className="space-y-2">
        {points.map((point, i) => {
          const left = (point.p50 / max) * 100;
          const right = (point.p90 / max) * 100;
          const peak = (point.max / max) * 100;
          const isActive = active === i;
          return (
            <li
              key={point.label}
              className="flex items-center gap-3 text-sm"
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
            >
              <span className="w-20 shrink-0 truncate text-xs text-muted-foreground">
                {point.label}
              </span>
              <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {point.activeUsers}
              </span>
              <span
                aria-hidden
                className={cn(
                  "relative h-2 flex-1 rounded-full bg-muted transition-colors",
                  isActive && "bg-muted/70"
                )}
              >
                <span
                  className="absolute inset-y-0 rounded-full bg-chart-3/70"
                  style={{
                    left: `${left}%`,
                    width: `${Math.max(right - left, 1)}%`,
                  }}
                />
                <span
                  className="absolute inset-y-[-3px] w-px bg-chart-5"
                  style={{ left: `${peak}%` }}
                />
              </span>
              <span className="w-32 shrink-0 text-right text-xs tabular-nums">
                {format(point.p50)} · {format(point.max)}
              </span>
            </li>
          );
        })}
      </ol>

      <p className="mt-3 text-xs text-muted-foreground">
        Accounts, then median and heaviest spend. Both columns are printed because the bar
        only ranks them.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------- ranked bars --------- */

export type RankedRow = {
  label: string;
  count: number;
  /** A strict subset of `count`, drawn inside the same track. */
  sub?: number;
  subLabel?: string;
  detail?: React.ReactNode;
  /**
   * What to print in the value column, when the raw `count` is not what a reader wants to
   * see. `count` still sizes the bar.
   *
   * Exists for money: the default cell is sized for the small integers this component was
   * written for (users, hits), and `525000` neither fits nor reads as dollars.
   */
  valueLabel?: string;
};

/**
 * `MiniBars` with somewhere to go.
 *
 * Rows with a zero count are kept rather than filtered out: for the paywall demand
 * screen, a wall nobody ever reaches is a finding — a feature in the wrong tier — and
 * dropping empty rows would hide exactly the thing worth noticing.
 */
export function RankedBars({
  rows,
  emptyLabel = "Nothing recorded in this window.",
}: {
  rows: RankedRow[];
  emptyLabel?: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const max = useMemo(() => Math.max(1, ...rows.map((r) => r.count)), [rows]);

  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  return (
    <ol className="space-y-1.5">
      {rows.map((row, i) => (
        <li
          key={row.label}
          onMouseEnter={() => setActive(i)}
          onMouseLeave={() => setActive(null)}
        >
          <div className="flex items-center gap-3 text-sm">
            <span className="w-36 shrink-0 truncate text-muted-foreground">
              {row.label}
            </span>
            <span
              className={cn(
                "shrink-0 text-right tabular-nums",
                row.valueLabel ? "w-24" : "w-10"
              )}
            >
              {row.valueLabel ?? row.count}
            </span>
            {row.sub != null && (
              <span
                className={cn(
                  "w-10 shrink-0 text-right text-xs tabular-nums",
                  row.sub > 0 ? "text-chart-2" : "text-muted-foreground/50"
                )}
                title={row.subLabel}
              >
                {row.sub > 0 ? row.sub : "—"}
              </span>
            )}
            <span
              aria-hidden
              className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
            >
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-primary/70 transition-[width] duration-slow ease-house"
                style={{ width: `${(row.count / max) * 100}%` }}
              />
              {row.sub != null && row.sub > 0 && (
                <span
                  className="absolute inset-y-0 left-0 rounded-full bg-chart-2/80"
                  style={{ width: `${(row.sub / max) * 100}%` }}
                />
              )}
            </span>
          </div>
          {row.detail && active === i && (
            <div className="mt-1 pl-[9.75rem] text-xs text-muted-foreground">
              {row.detail}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
