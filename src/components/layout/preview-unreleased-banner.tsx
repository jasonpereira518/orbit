"use client";

import { useTransition } from "react";
import { HardHat, X } from "lucide-react";
import { setPreviewUnreleasedAction } from "@/actions/admin";

/**
 * The bar an operator sees while reaching past a coming-soon page.
 *
 * Coming-soon pages default to closed for admins too (see `PREVIEW_UNRELEASED_COOKIE`), so
 * this is the opposite of `ViewAsUserBanner`: that one warns an operator they have LESS
 * access than usual, this one warns they have MORE — they are looking at a page real users
 * currently cannot reach. Same loud, in-flow treatment, same reason: an operator who forgets
 * they are in this mode should not mistake an unfinished page for a shipped one.
 */
export function PreviewUnreleasedBanner() {
  const [pending, start] = useTransition();

  return (
    <div className="flex shrink-0 items-center justify-center gap-3 border-b border-warning/40 bg-warning/15 px-4 py-1.5 text-xs text-warning">
      <HardHat className="size-3.5 shrink-0" aria-hidden />
      <p className="min-w-0 truncate">
        <span className="font-medium">Previewing unreleased pages</span>
        <span className="hidden sm:inline">
          {" · "}real users get the coming-soon screen instead
        </span>
      </p>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            await setPreviewUnreleasedAction({ on: false });
          })
        }
        className="flex shrink-0 items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 font-medium text-warning transition-colors hover:bg-warning/25 disabled:opacity-60"
      >
        <X className="size-3" aria-hidden />
        {pending ? "Exiting…" : "Exit"}
      </button>
    </div>
  );
}
