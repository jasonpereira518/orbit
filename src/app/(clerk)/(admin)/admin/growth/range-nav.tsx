import Link from "next/link";
import { RANGES, type Range } from "@/lib/admin-analytics";
import type { Grain } from "@/lib/admin-trends";
import {
  GRAIN_LABEL,
  GROWTH_GRAINS,
  GROWTH_RANGES,
  RANGE_LABEL,
  grainAllowed,
  growthHref,
  rangeSpanDays,
  type GrowthRange,
} from "@/lib/growth-range";

/**
 * The two window pickers the Growth tabs use. Links, not client state: the window belongs in
 * the URL, so a view can be linked and each tab stays a server component.
 *
 * Acquisition and Features read the traffic pipeline's fixed 7/30/90-day ranges; Activation
 * and Retention read `growth-range.ts`'s range + grain. Each link keeps the tab it is on.
 */
const TRAFFIC_LABEL: Record<Range, string> = { "7d": "7 days", "30d": "30 days", "90d": "90 days" };

export function TrafficRangeLinks({ base, range }: { base: string; range: Range }) {
  return (
    <nav aria-label="Time window" className="flex items-center gap-3 text-xs">
      {RANGES.map((value, i) => (
        <span key={value} className="flex items-center gap-3">
          {i > 0 && <span className="text-muted-foreground/40">·</span>}
          <Link
            href={`${base}${value === "30d" ? "" : `?range=${value}`}`}
            aria-current={range === value ? "page" : undefined}
            className={range === value ? "text-primary" : "text-muted-foreground hover:text-foreground"}
          >
            {TRAFFIC_LABEL[value]}
          </Link>
        </span>
      ))}
    </nav>
  );
}

export function GrowthWindowNav({
  base,
  range,
  grain,
  spanDays,
  first,
}: {
  base: string;
  range: GrowthRange;
  grain: Grain;
  spanDays: number;
  first: Date | null;
}) {
  return (
    <nav aria-label="Time window" className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
      <div className="flex items-center gap-3">
        {GROWTH_RANGES.map((r, i) => (
          <span key={r} className="flex items-center gap-3">
            {i > 0 && <span className="text-muted-foreground/40">·</span>}
            <Link
              href={growthHref(r, grainAllowed(grain, rangeSpanDays(r, first)) ? grain : null, base)}
              aria-current={range === r ? "page" : undefined}
              className={range === r ? "text-primary" : "text-muted-foreground hover:text-foreground"}
            >
              {RANGE_LABEL[r]}
            </Link>
          </span>
        ))}
      </div>
      <span aria-hidden className="h-3 w-px bg-border" />
      <div className="flex items-center gap-3">
        {GROWTH_GRAINS.map((g, i) => (
          <span key={g} className="flex items-center gap-3">
            {i > 0 && <span className="text-muted-foreground/40">·</span>}
            {grainAllowed(g, spanDays) ? (
              <Link
                href={growthHref(range, g, base)}
                aria-current={grain === g ? "page" : undefined}
                className={grain === g ? "text-primary" : "text-muted-foreground hover:text-foreground"}
              >
                {GRAIN_LABEL[g]}
              </Link>
            ) : (
              <span
                className="cursor-not-allowed text-muted-foreground/40"
                title={
                  g === "day"
                    ? "Daily stops at 90 days — past that it's a smear, not a chart."
                    : "One monthly bar for 30 days would be a single number."
                }
              >
                {GRAIN_LABEL[g]}
              </span>
            )}
          </span>
        ))}
      </div>
    </nav>
  );
}
