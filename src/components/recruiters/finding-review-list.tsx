"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import {
  approveFinding,
  rejectFinding,
  type PendingFinding,
} from "@/actions/recruiter-pipeline";
import { Button } from "@/components/ui/button";

/**
 * The review queue for findings the scan was not confident enough to apply.
 *
 * Each row shows the quote the stage was read from, so the decision takes a glance rather
 * than a trip to Gmail. Rejecting is not merely a dismissal — it records the sender as not a
 * recruiter, so the same thread cannot come back on the next scan.
 */
export function FindingReviewList({ findings }: { findings: PendingFinding[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Hide a row the moment it is acted on, so the list does not sit unchanged until the
  // server round trip and revalidation land.
  const [settled, setSettled] = useState<Set<string>>(new Set());

  const visible = findings.filter((f) => !settled.has(f.id));

  if (findings.length === 0) return null;

  async function act(id: string, approve: boolean) {
    setBusyId(id);
    setError(null);
    try {
      if (approve) await approveFinding(id);
      else await rejectFinding(id);
      setSettled((prev) => new Set(prev).add(id));
      start(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't save. Try again.");
    } finally {
      setBusyId(null);
    }
  }

  if (visible.length === 0) {
    return (
      <div className="rounded-2xl border border-border/70 bg-card px-5 py-8 text-center text-sm text-muted-foreground">
        Nothing left to review.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border/70 bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        These threads looked like hiring processes, but not clearly enough to add on their
        own. Nothing here has been saved yet.
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <ul className="space-y-2">
        {visible.map((finding) => (
          <li
            key={finding.id}
            className="rounded-xl border border-border/70 bg-card px-4 py-3"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p className="font-medium text-ink">
                {finding.company || "Unknown company"}
              </p>
              <p className="text-xs text-muted-foreground">
                {finding.confidence}% confident
              </p>
            </div>

            <p className="mt-1 text-sm text-muted-foreground">
              {finding.subject}
              {finding.correspondent ? ` — ${finding.correspondent}` : ""}
            </p>

            {finding.stageLabel && (
              <p className="mt-2 text-sm text-foreground">
                <span className="text-muted-foreground">Reads as: </span>
                {finding.stageLabel}
              </p>
            )}

            {finding.stageEvidence && (
              <p className="mt-2 border-l-2 border-border/70 pl-3 text-xs italic text-muted-foreground">
                “{finding.stageEvidence.trim().slice(0, 200)}”
              </p>
            )}

            <div className="mt-3 flex gap-2">
              <Button
                size="sm"
                onClick={() => act(finding.id, true)}
                disabled={busyId === finding.id || pending}
              >
                <Check className="mr-1 h-4 w-4" />
                Add to pipeline
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => act(finding.id, false)}
                disabled={busyId === finding.id || pending}
              >
                <X className="mr-1 h-4 w-4" />
                Not a recruiter
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
