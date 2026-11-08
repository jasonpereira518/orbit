"use client";

/**
 * "How did Pilot sync go?" in the bottom-right stack, for up to three hours after a meeting
 * with someone the user knows that was neither recorded nor written up. The meeting comes from
 * the app pulse (`unloggedMeeting`); "Add a note" opens Capture with the attendees already
 * seeded, so a two-line note still lands on the right people — or, when the meeting is an
 * Event, that event's debrief.
 *
 * Its sibling, `EventNoteCard`, is the morning after an event (`unloggedEvent`, 36 hours):
 * "How was it? Log who you met". The pulse never sends both for the same event.
 */

import Link from "next/link";
import { NotebookPen } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { useAppPulse } from "@/lib/app-pulse-store";
import { createDismissStore } from "@/lib/dismissed-ids";

const noteDismissals = createDismissStore("orbit:meeting-note-dismissed:v1");

type Pulse = NonNullable<ReturnType<typeof useAppPulse>["pulse"]>;
export type NoteOffer = NonNullable<Pulse["unloggedMeeting"]>;
export type EventNoteOffer = NonNullable<Pulse["unloggedEvent"]>;

export function useMeetingNoteCard(): NoteOffer | null {
  const { pulse } = useAppPulse();
  noteDismissals.useVersion();
  const meeting = pulse?.unloggedMeeting ?? null;
  if (!meeting || noteDismissals.isDismissed(meeting.eventId)) return null;
  return meeting;
}

export function useEventNoteCard(): EventNoteOffer | null {
  const { pulse } = useAppPulse();
  noteDismissals.useVersion();
  const event = pulse?.unloggedEvent ?? null;
  if (!event || noteDismissals.isDismissed(event.eventId)) return null;
  return event;
}

/** Ids are uuids from two different tables, so one dismissal store serves both cards. */
function NoteCardShell({
  dismissId,
  heading,
  detail,
  href,
  cta,
}: {
  dismissId: string;
  heading: string;
  detail: string | null;
  href: string;
  cta: string;
}) {
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-primary/30 bg-card/95 p-3 shadow-lg backdrop-blur-md"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-2.5">
        <NotebookPen className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">{heading}</p>
          {detail ? <p className="truncate text-xs text-muted-foreground">{detail}</p> : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Link href={href} onClick={() => noteDismissals.dismiss(dismissId)} className={buttonVariants({ size: "sm" })}>
          {cta}
        </Link>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => noteDismissals.dismiss(dismissId)}
        >
          Not now
        </Button>
      </div>
    </div>
  );
}

export function MeetingNoteCard({ offer }: { offer: NoteOffer }) {
  return (
    <NoteCardShell
      dismissId={offer.eventId}
      heading={`How did ${offer.title || "your meeting"} go?`}
      detail={offer.people.length > 0 ? `with ${offer.people.join(", ")}` : null}
      href={offer.debriefEventId ? `/capture?eventId=${offer.debriefEventId}` : `/capture?event=${offer.eventId}`}
      cta={offer.debriefEventId ? "Log who you met" : "Add a note"}
    />
  );
}

export function EventNoteCard({ offer }: { offer: EventNoteOffer }) {
  return (
    <NoteCardShell
      dismissId={offer.eventId}
      heading={`How was ${offer.title || "the event"}?`}
      detail="Log who you met while you remember"
      href={`/capture?eventId=${offer.eventId}`}
      cta="Log who you met"
    />
  );
}
