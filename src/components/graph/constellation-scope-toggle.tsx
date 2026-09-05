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

/**
 * Track and knob geometry, together because the travel is derived from the rest of it.
 *
 * The icon slots are exactly the knob's width and sit at each END of the track, so the knob
 * lands centred on one or the other — that is what makes this read as a knob sliding TO an
 * icon rather than past it. Both are laid out in the track's content box, so the travel is
 * that box's width minus the knob:
 *
 *     travel = track - 2*border - 2*padding - knob
 *            = 64    - 2*1      - 2*2       - 28    = 30
 *
 * The border is the term that is easy to forget, and forgetting it is not a rounding error you
 * can shrug at: `box-sizing: border-box` means the border comes out of the declared width, so
 * a travel measured off the full 64 overshoots by exactly 2px and the knob stops off-centre on
 * the icon it is sliding to. That is the bug this comment exists to stop happening again —
 * change any number here and re-run the sum.
 */
const TRACK = "h-8 w-16";
const KNOB = "h-7 w-7";
const SLIDE_ON = "translate-x-[30px]";
/** Smaller than the knob they sit in, so the knob reads as a disc under an icon, not a badge. */
const ICON = "size-3.5";

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
                "relative inline-flex shrink-0 items-center justify-between rounded-full border p-0.5",
                TRACK,
                // The focus ring is INSET. A ring drawn outside the pill is an outline around
                // the control, which is what this is asked not to have; drawn inside it, the
                // keyboard affordance is still there and the pill's own outer edge — border
                // included — is exactly the same shape whether it is focused or not.
                "transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
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
            <Stars className={ICON} />
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
              <Loader2 className={cn(ICON, "animate-spin")} />
            ) : (
              <Users className={ICON} />
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
