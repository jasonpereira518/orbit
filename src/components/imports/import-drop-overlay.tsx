"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Upload, UserPlus } from "lucide-react";
import { IMPORT_COPY } from "@/lib/imports/import-copy";
import { cn } from "@/lib/utils";

/**
 * The full-page affordance shown while a file is over the window.
 *
 * ## Why this is a portal
 *
 * Rendered in place, the overlay is a child of the page's `space-y-8` column, and Tailwind's
 * vertical rhythm applies a margin to it like any other sibling. For a `position: fixed` box
 * with `top: 0; bottom: 0` that margin is not inert — the over-constrained height equation
 * subtracts it — so the overlay resolved to 736px against a 768px viewport and left a strip of
 * the page uncovered at the bottom. A portal takes it out of that column entirely, which is
 * also what lets it cover the sidebar and the command bar rather than just the content well.
 *
 * `<html>` carries `view-transition-name: root`, which makes it a containing block for fixed
 * descendants. That is fine — its box is the viewport — but it is the reason this cannot be
 * fixed by escaping to some intermediate ancestor instead.
 *
 * ## Why it is pointer-transparent
 *
 * The window listener owns the drop, so the overlay never needs to receive one; and an overlay
 * that ate pointer events would kill the hero underneath it the moment a drag was cancelled
 * over it.
 *
 * The text is announced through a polite live region rather than by the overlay itself, so a
 * screen-reader user hears "drop to import" without the decorative frame being read out.
 */
export function ImportDropOverlay({
  active,
  kind = "files",
}: {
  active: boolean;
  /** A dragged link adds a person rather than importing a file, and the hint says so. */
  kind?: "files" | "text" | null;
}) {
  const hint = kind === "text" ? IMPORT_COPY.linkDropHint : IMPORT_COPY.dropHint;
  // Portals need a DOM target, and `document.body` does not exist during SSR.
  //
  // `useSyncExternalStore(noop, () => true, () => false)` looks tidier and is what
  // `app-starfield.tsx` argues for — but it does not work here. Its subscribe never notifies,
  // so after hydrating with the server snapshot React has no reason to re-read the store, and
  // the portal never appears at all. The starfield gets away with it because its store is the
  // theme, which really does emit. This is the gate `contact-preview-card.tsx` and
  // `contacts-list.tsx` already use.
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- mount detection; see above
  useEffect(() => setMounted(true), []);

  const live = (
    <div className="sr-only" role="status" aria-live="polite">
      {active ? hint : ""}
    </div>
  );

  if (!mounted) return live;

  return (
    <>
      {live}
      {createPortal(
        <div
          aria-hidden
          className={cn(
            // Above the command bar and the sidebar: while a drag is live, the whole window is
            // the target, and anything still looking interactive would be a lie.
            "pointer-events-none fixed inset-0 z-[60] flex items-center justify-center",
            "bg-background/70 backdrop-blur-sm",
            "transition-opacity duration-150 motion-reduce:transition-none",
            active ? "opacity-100" : "opacity-0",
          )}
        >
          <div className="absolute inset-4 rounded-[1.75rem] border-2 border-dashed border-primary/50 bg-primary/5" />
          <p className="relative flex items-center gap-2.5 rounded-full border border-primary/30 bg-card px-6 py-3 text-base font-medium text-primary shadow-xl">
            {kind === "text" ? (
              <UserPlus className="size-5" />
            ) : (
              <Upload className="size-5" />
            )}
            {hint}
          </p>
        </div>,
        document.body,
      )}
    </>
  );
}
