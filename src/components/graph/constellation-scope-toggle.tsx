"use client";

import { useSyncExternalStore } from "react";
import { Loader2, Stars, Users } from "lucide-react";
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
} from "@/lib/graph/scope-signal";
import { cn } from "@/lib/utils";

/**
 * Switch the star chart between the people you have engaged with and everyone.
 *
 * It lives in the page header rather than over the canvas because the canvas is where the
 * stars are: anything parked on top of it is either covering someone's network or dodging out
 * of the way of it, and the version this replaces did both. Up here it never overlaps the
 * chart, never has to hide, and is in the one place a page-level control belongs.
 *
 * A switch rather than a button, because the two views are a setting rather than an action —
 * both sides are visible at once and the knob slides to whichever one is live, so the choice
 * and the current state are the same piece of UI. `role="switch"` says the same thing to a
 * screen reader; the counts, which a control this size cannot show, lead the accessible name
 * and the tooltip.
 *
 * Renders nothing until a chart says the filter is on. With it off there is only one view, and
 * a control that toggles between two identical charts would be worse than no control.
 */

/** Track and knob geometry, shared so the slide distance cannot drift from the track width. */
const KNOB = "h-7 w-7";
const SLIDE_ON = "translate-x-7";

export function ConstellationScopeToggle({ className }: { className?: string }) {
  const state = useSyncExternalStore(
    subscribeGraphScope,
    getGraphScopeState,
    getGraphScopeState
  );

  if (!state.available) return null;

  const showingAll = state.scope === "all";
  const total = state.total.toLocaleString();
  const label = state.loading
    ? `Loading all ${total} connections…`
    : showingAll
      ? `Showing all ${total} connections. Show only the people you have engaged with.`
      : `Showing ${state.shown.toLocaleString()} of ${total} — the people you have engaged with. Show all ${total} connections.`;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              // The whole point of the request: everyone is never fetched until this is
              // switched on, and switching back is free because the chart keeps both payloads.
              onClick={() => requestGraphScope(showingAll ? "engaged" : "all")}
              disabled={state.loading}
              aria-busy={state.loading}
              role="switch"
              aria-checked={showingAll}
              aria-label={label}
              className={cn(
                "relative inline-flex h-8 w-[3.75rem] shrink-0 items-center rounded-full border p-0.5",
                "transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                "disabled:pointer-events-none disabled:opacity-60",
                showingAll
                  ? "border-primary/40 bg-primary/15"
                  : "border-border bg-muted dark:bg-input/30",
                className
              )}
            />
          }
        >
          {/*
            The knob, under the icons rather than over them: it slides beneath whichever side
            is live and lights that icon through, which is what makes the switch read as
            "here, not there" instead of as two buttons one of which happens to be shaded.
          */}
          <span
            aria-hidden
            className={cn(
              "absolute left-0.5 rounded-full bg-background shadow-sm",
              "transition-transform duration-200 ease-out motion-reduce:transition-none",
              KNOB,
              showingAll ? SLIDE_ON : "translate-x-0"
            )}
          />
          <span
            aria-hidden
            className={cn(
              "relative z-10 grid place-items-center transition-colors",
              KNOB,
              showingAll ? "text-muted-foreground/60" : "text-foreground"
            )}
          >
            <Stars className="size-4" />
          </span>
          <span
            aria-hidden
            className={cn(
              "relative z-10 grid place-items-center transition-colors",
              KNOB,
              showingAll ? "text-primary" : "text-muted-foreground/60"
            )}
          >
            {/* The spinner replaces the side being travelled TO, so the wait is attached to
                the thing being waited for rather than floating over the whole control. */}
            {state.loading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Users className="size-4" />
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end">
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
