"use client";

import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import type { GraphPayload } from "@/components/graph/graph-chart-types";

/**
 * The three empty skies, shared by both renderers.
 *
 * "Add contacts" is right only when there genuinely are none — said to someone whose 800
 * contacts were filtered out it is both wrong and unactionable, and it points at the one
 * button that will not help. The desktop chart had these three; the phone canvas had
 * nothing at all, so an empty sky there was just black.
 *
 * Wrapped in `.dark` because the sky is always dark: the card then draws itself with the
 * dark theme's tokens whatever the app's theme, instead of a light card floating in space.
 */
export function SkyEmptyState({
  data,
  constellationFilterOn,
  loadingAll,
  onShowAll,
}: {
  data: Pick<GraphPayload, "contacts" | "summary">;
  constellationFilterOn: boolean;
  loadingAll: boolean;
  onShowAll: () => void;
}) {
  let body: React.ReactNode;
  if (data.summary.total === 0) {
    body = (
      <EmptyState
        variant="card"
        title="Your sky is empty"
        description="Add contacts and they will appear as stars in your constellation."
        action={
          <Link href="/contacts/new" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Add a contact
          </Link>
        }
      />
    );
  } else if (constellationFilterOn && data.contacts.length === 0) {
    body = (
      <EmptyState
        variant="card"
        title="Nobody here yet"
        description="Your chart shows the people you have notes on, met, or really talked with. Write a note about someone and they take their place in the sky."
        action={
          <>
            <Link href="/capture" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Add notes
            </Link>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={loadingAll}
              onClick={onShowAll}
              aria-busy={loadingAll}
            >
              {loadingAll && <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden />}
              {loadingAll ? "Loading…" : `Show all ${data.summary.total.toLocaleString()}`}
            </Button>
          </>
        }
      />
    );
  } else {
    body = (
      <EmptyState
        variant="card"
        title="No stars match"
        description={
          constellationFilterOn
            ? "Nobody fits these filters and the people you know. Widen the filters, or show everyone."
            : "Nobody fits these filters. Try widening them."
        }
      />
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-4">
      <div className="dark pointer-events-auto w-full max-w-sm rounded-xl shadow-lg">{body}</div>
    </div>
  );
}
