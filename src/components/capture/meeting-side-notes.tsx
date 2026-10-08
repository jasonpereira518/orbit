"use client";

/**
 * The notes box: one running block of text for whatever the user wants to jot while a
 * meeting is running — names, numbers, to-dos. It is not time-stamped or submitted note by
 * note: it just goes with the recording, and is sent along with the transcript when the
 * meeting is finished (see `userNotes` in `meeting-digest.ts`).
 *
 * Two sizes over the same text: the big box on /capture, and a smaller one in the
 * bottom-right widget (`compact`) for when the call is in another window.
 */

import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export function SideNotes({
  value,
  onChange,
  compact = false,
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  compact?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <div className="space-y-2">
      {!compact && (
        <div>
          <label htmlFor="meeting-side-notes" className="text-sm font-medium text-ink">
            Your notes
          </label>
          <p className="text-xs text-muted-foreground">
            Names, numbers, to-dos — anything. Only you see this. It&apos;s saved in this browser as you
            type and goes with the recording when you finish the meeting.
          </p>
        </div>
      )}
      <Textarea
        id={compact ? undefined : "meeting-side-notes"}
        aria-label="Your notes for this meeting"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Priya — Stripe, wants the intro to Marcus&#10;Send the pricing deck Friday…"
        className={cn(
          "resize-y leading-relaxed",
          compact ? "min-h-24 text-sm" : "min-h-56"
        )}
      />
    </div>
  );
}
