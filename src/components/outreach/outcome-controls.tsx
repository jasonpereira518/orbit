"use client";

import { useState, useTransition } from "react";
import { toast } from "@/lib/toast";
import { logMessageOutcome } from "@/actions/outreach";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  OUTCOME_LABELS,
  type OutreachMessageOutcome,
} from "@/lib/outreach-types";

const QUICK_OUTCOMES: OutreachMessageOutcome[] = [
  "positive_reply",
  "negative_reply",
  "neutral_reply",
  "bounced",
];

export function OutcomeControls({
  messageId,
  currentOutcome,
  onUpdated,
}: {
  messageId: string;
  currentOutcome?: string | null;
  onUpdated?: () => void;
}) {
  const [pending, start] = useTransition();
  const [notes, setNotes] = useState("");
  const [showNotes, setShowNotes] = useState(false);

  function log(outcome: OutreachMessageOutcome) {
    start(async () => {
      try {
        await logMessageOutcome({
          messageId,
          outcome,
          notes: notes.trim() || null,
        });
        toast.success(OUTCOME_LABELS[outcome]);
        setNotes("");
        setShowNotes(false);
        onUpdated?.();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to log outcome");
      }
    });
  }

  if (currentOutcome) {
    return (
      <div className="text-xs text-muted-foreground">
        Outcome:{" "}
        <span className="text-foreground">
          {OUTCOME_LABELS[currentOutcome as OutreachMessageOutcome] ||
            currentOutcome}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {QUICK_OUTCOMES.map((outcome) => (
          <Button
            key={outcome}
            size="xs"
            variant={outcome === "positive_reply" ? "default" : "outline"}
            disabled={pending}
            onClick={() => log(outcome)}
          >
            {outcome === "positive_reply"
              ? "Positive"
              : outcome === "negative_reply"
                ? "Negative"
                : outcome === "neutral_reply"
                  ? "Neutral"
                  : "Bounced"}
          </Button>
        ))}
        <Button
          size="xs"
          variant="ghost"
          disabled={pending}
          onClick={() => setShowNotes((v) => !v)}
        >
          Notes
        </Button>
      </div>
      {showNotes && (
        <div className="space-y-2">
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Optional notes about the reply"
          />
        </div>
      )}
    </div>
  );
}
