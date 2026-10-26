"use client";

import { useState } from "react";
import { toast } from "@/lib/toast";
import { logMessageOutcome } from "@/actions/outreach";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { OUTCOME_LABELS, type OutreachMessageOutcome } from "@/lib/outreach-types";
import { friendlyError } from "@/lib/errors";

/**
 * What came of a sent message. No outcome means still waiting, so there is no "No reply" button.
 * The buttons stay live once one is set: a reply Orbit noticed ("Replied") can be refined to
 * Positive or Negative, and a mistaken one corrected. The current outcome shows as pressed.
 */
const OUTCOME_BUTTONS = [
  { outcome: "replied", label: "Replied" },
  { outcome: "positive_reply", label: "Positive" },
  { outcome: "negative_reply", label: "Negative" },
  { outcome: "bounced", label: "Bounced" },
] as const satisfies readonly { outcome: OutreachMessageOutcome; label: string }[];

export function OutcomeControls({
  messageId,
  currentOutcome,
  onUpdated,
}: {
  messageId: string;
  currentOutcome?: string | null;
  onUpdated?: () => void;
}) {
  const [pending, setPending] = useState<OutreachMessageOutcome | null>(null);
  const [notes, setNotes] = useState("");
  const [showNotes, setShowNotes] = useState(false);

  async function log(outcome: OutreachMessageOutcome) {
    if (pending || outcome === currentOutcome) return;
    setPending(outcome);
    try {
      // No notes typed leaves any saved notes alone (`null` would clear them).
      await logMessageOutcome({ messageId, outcome, notes: notes.trim() || undefined });
      toast.success(OUTCOME_LABELS[outcome]);
      setNotes("");
      setShowNotes(false);
      onUpdated?.();
    } catch (err) {
      toast.error(friendlyError(err, "Couldn’t log that outcome — try again?"));
    } finally {
      setPending(null);
    }
  }

  // An outcome Orbit tracks but this row doesn’t offer (a neutral reply, an unsubscribe).
  const other =
    currentOutcome && !OUTCOME_BUTTONS.some((b) => b.outcome === currentOutcome)
      ? (OUTCOME_LABELS[currentOutcome as OutreachMessageOutcome] ?? currentOutcome)
      : null;

  return (
    <div className="space-y-2">
      <div role="group" aria-label="What came of this message" className="flex flex-wrap items-center gap-1">
        {OUTCOME_BUTTONS.map(({ outcome, label }) => (
          <Button
            key={outcome}
            size="xs"
            variant={currentOutcome === outcome ? "default" : "outline"}
            aria-pressed={currentOutcome === outcome}
            disabled={pending !== null}
            onClick={() => log(outcome)}
          >
            {label}
          </Button>
        ))}
        <Button size="xs" variant="ghost" disabled={pending !== null} onClick={() => setShowNotes((v) => !v)}>
          Notes
        </Button>
        {other && <span className="text-xs text-muted-foreground">Marked: {other}</span>}
      </div>
      {showNotes && (
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          aria-label="Notes about the reply"
          placeholder="Optional notes about the reply"
        />
      )}
    </div>
  );
}
