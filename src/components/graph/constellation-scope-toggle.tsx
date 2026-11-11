"use client";

import { tourAnchor } from "@/lib/tour/tour-anchors";
import { useSyncExternalStore } from "react";
import { Loader2 } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  getGraphScopeState,
  requestGraphScope,
  subscribeGraphScope,
  wasGraphScopeEverAvailable,
  type GraphScopeName,
} from "@/lib/graph/scope-signal";
import { cn } from "@/lib/utils";

/**
 * Top | All: the star chart's people you have engaged with (meetings, notes, real two-way
 * exchanges, priorities you set) or every person in the network.
 *
 * It lives in the page header rather than over the canvas because the canvas is where the
 * stars are: anything parked on top of it is either covering someone's network or dodging out
 * of the way of it.
 *
 * Two labelled segments rather than an icon switch, so the choice reads without a tooltip. The
 * counts, which a control this size cannot show, are in each segment's accessible name and
 * tooltip. Inside a saved view (`lockedCount`) its members are explicit, not a filter, so both
 * segments grey out in place — same size, no shift — and the tooltip says what the view shows.
 *
 * Renders nothing until a chart says the filter is on. With it off there is only one view, and
 * a control that toggles between two identical charts would be worse than no control.
 */

/** The look the views menu's trigger shares, so the two read as one control group. */
export const CONTROL_SHELL =
  "inline-flex h-8 shrink-0 items-center rounded-full border border-border bg-muted dark:bg-input/30";

const people = (n: number) => `${n.toLocaleString()} ${n === 1 ? "person" : "people"}`;

export function ConstellationScopeToggle({
  lockedCount,
  className,
}: {
  /** Set inside a saved view: the view's member count. Disables both segments. */
  lockedCount?: number;
  className?: string;
}) {
  const state = useSyncExternalStore(
    subscribeGraphScope,
    getGraphScopeState,
    getGraphScopeState
  );

  // Between views the chart releases the bus (state resets); keep the space, greyed.
  if (!state.available && !wasGraphScopeEverAvailable()) return null;

  const locked = lockedCount !== undefined;
  const idle = !state.available || state.loading;
  const segments: Array<{ scope: GraphScopeName; label: string; tip: string }> = [
    {
      scope: "engaged",
      label: "Top",
      tip: `${people(state.shown)} you’ve engaged with — meetings, notes, real conversations`,
    },
    { scope: "all", label: "All", tip: `Every one of your ${state.total.toLocaleString()} connections` },
  ];

  return (
    <TooltipProvider>
      <div
        role="group"
        aria-label="Who the chart shows"
        {...tourAnchor("graph.show-all")}
        className={cn(CONTROL_SHELL, "p-0.5", className)}
      >
        {segments.map(({ scope, label, tip }) => {
          const on = !locked && state.scope === scope;
          const tipText = locked ? `This constellation shows its ${people(lockedCount)}` : tip;
          // aria-disabled, not disabled: a disabled button gets no hover, and the locked
          // tooltip is the one place that says why the control is grey.
          const inert = locked || idle;
          return (
            <Tooltip key={scope}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-pressed={on}
                    aria-disabled={inert || undefined}
                    aria-busy={scope === "all" && state.loading ? true : undefined}
                    aria-label={`${label}: ${tipText}`}
                    // The whole point of the request: everyone is never fetched until All is
                    // picked, and going back is free because the chart keeps both payloads.
                    onClick={() => {
                      if (!inert && !on) requestGraphScope(scope);
                    }}
                    className={cn(
                      "inline-flex h-7 min-w-8 items-center justify-center rounded-full px-1.5 text-xs font-medium transition-colors sm:min-w-10 sm:px-2.5",
                      // Inset ring: the shell's outer edge stays the same shape focused or not.
                      "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
                      on
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                      inert && "cursor-default opacity-50 hover:text-muted-foreground"
                    )}
                  />
                }
              >
                {/* The spinner replaces the label being travelled to, so the wait is attached
                    to the thing being waited for. min-w keeps the width. */}
                {scope === "all" && state.loading ? (
                  <Loader2 aria-hidden className="size-3.5 animate-spin" />
                ) : (
                  label
                )}
              </TooltipTrigger>
              <TooltipContent side="bottom" align="end">
                {tipText}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
