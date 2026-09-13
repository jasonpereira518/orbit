"use client";

import { Button } from "@/components/ui/button";

/** Keeps "this page" and "everything matching" visibly different (spec §7.7). */
export function SelectionBanner({
  mode,
  pageCount,
  matching,
  selected,
  busy,
  onSelectAll,
  onClear,
}: {
  mode: "page" | "all";
  pageCount: number;
  matching: number;
  selected: number;
  busy: boolean;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-primary/5 px-4 py-2.5 text-sm">
      {mode === "page" ? (
        <>
          <span>
            {pageCount} on this page selected.
          </span>
          <Button variant="link" size="sm" className="h-auto p-0" disabled={busy} onClick={onSelectAll}>
            Select all {matching} matching
          </Button>
        </>
      ) : (
        <>
          <span>All {selected} matching people selected.</span>
          <Button variant="link" size="sm" className="h-auto p-0" disabled={busy} onClick={onClear}>
            Clear selection
          </Button>
        </>
      )}
    </div>
  );
}
