"use client";

/**
 * The five people worth finding — or, afterwards, worth following up with.
 *
 * ## Reasons, not a score
 *
 * The number is never shown. "87" tells nobody anything; "Recruiting at a careers fair · on
 * your target list · you know 2 people there" is something a person can act on while standing
 * in a doorway, and it is checkable — if a reason is wrong, the user can see that it is wrong,
 * which a score hides.
 *
 * The AI line is a separate button per person for the same reason it is a separate action:
 * it costs a model call against the user's own key, and the card is useful without it.
 */
import { useState, useTransition } from "react";
import { Link2, Loader2, Sparkles, Users } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { explainAttendee } from "@/actions/events";
import type { WhoToTalkTo } from "@/lib/events/who-to-talk-to";

export function WhoToTalkToCard({
  eventId,
  data,
  aiAvailable,
}: {
  eventId: string;
  data: WhoToTalkTo;
  aiAvailable: boolean;
}) {
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, { why: string; opener: string }>>({});

  // Nothing worth saying is better than a padded list: an empty card here means the roster
  // holds nobody the facts single out, which is honest and common for a small event.
  if (data.rows.length === 0) return null;

  function explain(attendeeId: string) {
    setBusy(attendeeId);
    start(async () => {
      try {
        const result = await explainAttendee(eventId, attendeeId);
        if (!result.ok) {
          toast.error(result.error ?? "Couldn’t write that just now");
          return;
        }
        setNotes((prev) => ({
          ...prev,
          [attendeeId]: { why: result.why ?? "", opener: result.opener ?? "" },
        }));
      } finally {
        setBusy(null);
      }
    });
  }

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-5">
      <h2 className="flex items-center gap-2 font-medium text-ink">
        <Users className="size-4 text-muted-foreground" aria-hidden />
        {data.when === "upcoming" ? "Before you go" : "Worth following up"}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {data.when === "upcoming"
          ? `${data.rows.length} ${data.rows.length === 1 ? "person" : "people"} on this guest list worth finding.`
          : "The people from this room most worth a message now."}
      </p>

      <ul className="mt-4 space-y-3">
        {data.rows.map((row) => {
          const note = notes[row.attendeeId];
          const detail = [row.title, row.company].filter(Boolean).join(" · ");
          return (
            <li key={row.attendeeId} className="rounded-xl border border-border/60 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">
                    {row.contactId ? (
                      <Link href={`/contacts/${row.contactId}`} className="hover:underline">
                        {row.name}
                      </Link>
                    ) : (
                      row.name
                    )}
                  </p>
                  {detail ? (
                    <p className="truncate text-xs text-muted-foreground">{detail}</p>
                  ) : null}
                </div>
                {aiAvailable ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => explain(row.attendeeId)}
                    disabled={pending}
                  >
                    {busy === row.attendeeId ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : (
                      <Sparkles className="size-3.5" aria-hidden />
                    )}
                    What to say
                  </Button>
                ) : null}
              </div>

              {/* The reasons the ranking actually used. Checkable, and the whole point. */}
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {row.reasons.slice(0, 3).map((reason) => (
                  <li
                    key={reason.code}
                    className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {reason.label}
                  </li>
                ))}
              </ul>

              {note ? (
                <div className="mt-2 space-y-1 border-l-2 border-primary/30 pl-3">
                  {note.why ? <p className="text-xs text-muted-foreground">{note.why}</p> : null}
                  {note.opener ? (
                    <p className="text-sm text-ink">
                      <Link2 className="mr-1 inline size-3 text-muted-foreground" aria-hidden />
                      &ldquo;{note.opener}&rdquo;
                    </p>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
