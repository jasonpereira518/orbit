"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * "Refresh now", with the run's progress filled in behind its label. A fixed minimum width keeps
 * the toolbar from shifting as the label goes from "Refresh now" to "Refreshing 42%".
 *
 * Progress is spoken from a live region beside the button, not from the button: a button can't
 * carry aria-value*. Quarter steps, so the stages don't each get announced.
 */
export function RefreshRadarButton({
  busy,
  percent,
  onClick,
}: {
  busy: boolean;
  /** 0-100; only read while `busy`. */
  percent: number;
  onClick: () => void;
}) {
  const pct = Math.min(100, Math.max(0, Math.round(percent)));
  return (
    <>
      <span role="status" className="sr-only">
        {busy ? `Refreshing Radar, ${Math.floor(pct / 25) * 25}% done` : ""}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="relative h-8 min-w-[9.5rem] justify-center overflow-hidden"
        disabled={busy}
        aria-busy={busy}
        onClick={onClick}
      >
        {busy && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 bg-primary/15 transition-[width] duration-slow ease-house motion-reduce:transition-none"
            style={{ width: `${pct}%` }}
          />
        )}
        <RefreshCw className={busy ? "relative size-3.5 animate-spin motion-reduce:animate-none" : "relative size-3.5"} aria-hidden />
        <span className="relative tabular-nums">{busy ? `Refreshing ${pct}%` : "Refresh now"}</span>
      </Button>
    </>
  );
}
