"use client";

import { useSyncExternalStore } from "react";
import { Loader2, Stars, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
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
 * The cost of a circular button is that it cannot state the counts the way a chip could, and
 * the filter can be hiding most of a network — so the numbers move into the tooltip and the
 * accessible name, both of which lead with them. The `Users` icon and the pressed styling are
 * what carry "you are looking at everyone" at a glance.
 *
 * Renders nothing until a chart says the filter is on. With it off there is only one view, and
 * a control that toggles between two identical charts would be worse than no control.
 */
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
            <Button
              type="button"
              variant="outline"
              size="icon-lg"
              // The whole point of the request: everyone is never fetched until this is
              // pressed, and pressing it back is free because the chart keeps both payloads.
              onClick={() => requestGraphScope(showingAll ? "engaged" : "all")}
              disabled={state.loading}
              aria-busy={state.loading}
              aria-pressed={showingAll}
              aria-label={label}
              className={cn(
                "rounded-full",
                // `hover:text-primary` is not redundant: the outline variant ships
                // `hover:text-foreground`, which otherwise drains the tint off the pressed
                // state the moment you point at it — the one moment it most needs to read.
                showingAll &&
                  "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary dark:bg-primary/15",
                className
              )}
            />
          }
        >
          {state.loading ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : showingAll ? (
            <Users className="size-4" aria-hidden />
          ) : (
            <Stars className="size-4" aria-hidden />
          )}
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end">
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
