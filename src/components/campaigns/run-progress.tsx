"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { RunSummary } from "@/lib/outreach/discovery/run";

const PHASE: Record<RunSummary["phase"], string> = {
  planning: "Planning searches…",
  searching: "Searching…",
  ranking: "Ranking what was found…",
  researching: "Researching the best matches…",
  finishing: "Finishing…",
};

const DONE: Record<string, string> = {
  completed: "Search finished",
  partial: "Search finished with gaps — some sources didn’t respond, and everything found is kept",
  failed: "Search stopped",
  cancelled: "Search cancelled",
};

export function RunProgress({ run, busy, onCancel }: { run: RunSummary; busy: boolean; onCancel: () => void }) {
  const active = run.status === "queued" || run.status === "running";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card px-5 py-4">
      <div role="status" aria-live="polite" className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium text-ink">
          {active ? PHASE[run.phase] : DONE[run.status]}
          {run.demo && (
            <Badge variant="secondary" className="ml-2 align-middle">
              Sample data
            </Badge>
          )}
        </p>
        <p className="text-sm text-muted-foreground">
          {run.candidatesFound} found · {run.researchUsed} of {run.researchBudget} researched
          {run.fundingSource === "orbit" ? " on Orbit’s allowance" : " on your keys"}
        </p>
        {run.error && <p className="text-sm text-destructive">{run.error}</p>}
      </div>
      {active && (
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          Stop search
        </Button>
      )}
    </div>
  );
}
