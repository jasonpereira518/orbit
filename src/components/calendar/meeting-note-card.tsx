"use client";

/**
 * "How did Pilot sync go?" in the bottom-right stack, for up to three hours after a meeting
 * with someone the user knows that was neither recorded nor written up. The meeting comes from
 * the app pulse (`unloggedMeeting`); "Add a note" opens Capture with the attendees already
 * seeded, so a two-line note still lands on the right people.
 */

import Link from "next/link";
import { NotebookPen } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { useAppPulse } from "@/lib/app-pulse-store";
import { createDismissStore } from "@/lib/dismissed-ids";

const noteDismissals = createDismissStore("orbit:meeting-note-dismissed:v1");

export type NoteOffer = NonNullable<NonNullable<ReturnType<typeof useAppPulse>["pulse"]>["unloggedMeeting"]>;

export function useMeetingNoteCard(): NoteOffer | null {
  const { pulse } = useAppPulse();
  noteDismissals.useVersion();
  const meeting = pulse?.unloggedMeeting ?? null;
  if (!meeting || noteDismissals.isDismissed(meeting.eventId)) return null;
  return meeting;
}

export function MeetingNoteCard({ offer }: { offer: NoteOffer }) {
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-primary/30 bg-card/95 p-3 shadow-lg backdrop-blur-md"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-2.5">
        <NotebookPen className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">How did {offer.title || "your meeting"} go?</p>
          {offer.people.length > 0 && (
            <p className="truncate text-xs text-muted-foreground">with {offer.people.join(", ")}</p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/capture?event=${offer.eventId}`}
          onClick={() => noteDismissals.dismiss(offer.eventId)}
          className={buttonVariants({ size: "sm" })}
        >
          Add a note
        </Link>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => noteDismissals.dismiss(offer.eventId)}
        >
          Not now
        </Button>
      </div>
    </div>
  );
}
