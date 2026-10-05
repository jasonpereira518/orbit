import type { Grain } from "@/lib/admin-trends";

/**
 * The Growth page's window: how far back, and how finely bucketed.
 *
 * Dependency-free (the `Grain` import is type-only) so the smoke suite can exercise the
 * parsing without a database, and so nothing here can drag `@/db` into a client bundle.
 *
 * Both values arrive as URL search params and both are closed sets — anything unrecognised
 * falls back to the default rather than reaching SQL. The window lives in the URL, not in
 * component state, so a view can be linked and the page stays a server component.
 */

export type GrowthRange = "30d" | "90d" | "12m" | "all";

export const GROWTH_RANGES: readonly GrowthRange[] = ["30d", "90d", "12m", "all"];
export const GROWTH_GRAINS: readonly Grain[] = ["day", "week", "month"];

export const DEFAULT_RANGE: GrowthRange = "90d";

/** Past this many buckets a bar is thinner than a hairline and the chart is noise. */
export const MAX_BUCKETS = 120;

/** Daily bars over a year are 365 slivers; day grain stops at 90 days. */
export const MAX_DAY_GRAIN_DAYS = 90;

const GRAIN_DAYS: Record<Grain, number> = { day: 1, week: 7, month: 30.44 };

export const RANGE_LABEL: Record<GrowthRange, string> = {
  "30d": "30 days",
  "90d": "90 days",
  "12m": "12 months",
  all: "All time",
};

export const GRAIN_LABEL: Record<Grain, string> = {
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
};

/** The grain each range opens at when the URL does not name one. */
function defaultGrain(range: GrowthRange): Grain {
  if (range === "30d") return "day";
  if (range === "90d") return "week";
  return "month";
}

/**
 * Days the range spans. `all` needs the first signup to answer, and counts from the start
 * of that day; with no accounts at all it collapses to 30 days so the spine still draws.
 */
export function rangeSpanDays(
  range: GrowthRange,
  firstSignupAt: Date | null,
  now: Date = new Date()
): number {
  if (range === "30d") return 30;
  if (range === "90d") return 90;
  if (range === "12m") return 365;
  if (!firstSignupAt) return 30;
  const ms = now.getTime() - firstSignupAt.getTime();
  return Math.max(1, Math.ceil(ms / 86_400_000));
}

/** Whether a grain is offered for a span — the controls grey out the rest. */
export function grainAllowed(grain: Grain, spanDays: number): boolean {
  if (grain === "day") return spanDays <= MAX_DAY_GRAIN_DAYS;
  // A single monthly bar for a 30-day window is a stat tile, not a chart.
  if (grain === "month") return spanDays > 31;
  return true;
}

export type GrowthWindow = {
  range: GrowthRange;
  grain: Grain;
  /** Number of buckets on the spine, current bucket included. */
  buckets: number;
  spanDays: number;
};

export function parseRange(value: string | undefined): GrowthRange {
  return GROWTH_RANGES.includes(value as GrowthRange)
    ? (value as GrowthRange)
    : DEFAULT_RANGE;
}

/**
 * Resolves the URL's `range` and `grain` into a spine the queries can use.
 *
 * A grain the span does not allow (daily over a year) is replaced by the range's default
 * rather than rejected, so a hand-edited URL still renders something sensible.
 */
export function resolveGrowthWindow(
  params: { range?: string; grain?: string },
  firstSignupAt: Date | null,
  now: Date = new Date()
): GrowthWindow {
  const range = parseRange(params.range);
  const spanDays = rangeSpanDays(range, firstSignupAt, now);
  const requested = GROWTH_GRAINS.includes(params.grain as Grain)
    ? (params.grain as Grain)
    : null;
  let grain =
    requested && grainAllowed(requested, spanDays) ? requested : defaultGrain(range);
  if (!grainAllowed(grain, spanDays)) grain = "week";

  const buckets = Math.min(
    MAX_BUCKETS,
    Math.max(2, Math.ceil(spanDays / GRAIN_DAYS[grain]))
  );
  return { range, grain, buckets, spanDays };
}

/** The query string for a window, omitting whatever is already the default. */
export function growthHref(range: GrowthRange, grain: Grain | null): string {
  const params = new URLSearchParams();
  if (range !== DEFAULT_RANGE) params.set("range", range);
  if (grain && grain !== defaultGrain(range)) params.set("grain", grain);
  const qs = params.toString();
  return `/admin/growth${qs ? `?${qs}` : ""}`;
}

/* ------------------------------------------------------------------- labels --------- */

// Buckets come back as UTC midnights from date_trunc, so every label is formatted in UTC —
// in local time a Monday bucket would read as Sunday for anyone west of Greenwich.

export function shortLabel(d: Date, grain: Grain) {
  if (grain === "month") {
    return d.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function longLabel(d: Date, grain: Grain) {
  if (grain === "month") return monthLabel(d);
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  if (grain === "week") return `Week of ${date}`;
  const weekday = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  return `${weekday}, ${date}`;
}

export function monthLabel(d: Date) {
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}
