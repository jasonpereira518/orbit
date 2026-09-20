"use client";

import { Upload } from "lucide-react";
import { IMPORT_COPY } from "@/lib/imports/import-copy";
import { cn } from "@/lib/utils";

/**
 * The full-page affordance shown while a file is over the window.
 *
 * `pointer-events-none` is not a detail: the window listener owns the drop, and an overlay
 * that ate pointer events would stop the hero underneath it from being clickable the moment a
 * drag was cancelled over it.
 *
 * The text is announced through a polite live region rather than by the overlay itself, so a
 * screen-reader user hears "drop to import" without the decorative frame being read out.
 */
export function ImportDropOverlay({ active }: { active: boolean }) {
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite">
        {active ? IMPORT_COPY.dropHint : ""}
      </div>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none fixed inset-0 z-50 flex items-center justify-center",
          "bg-primary/5 backdrop-blur-[1px] transition-opacity duration-150",
          "motion-reduce:transition-none",
          active ? "opacity-100" : "opacity-0",
        )}
      >
        <div className="absolute inset-3 rounded-3xl border-2 border-dashed border-primary/40" />
        <p className="flex items-center gap-2.5 rounded-full border border-primary/30 bg-card px-5 py-2.5 text-sm font-medium text-primary shadow-lg">
          <Upload className="size-4" />
          {IMPORT_COPY.dropHint}
        </p>
      </div>
    </>
  );
}
