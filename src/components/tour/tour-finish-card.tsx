"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Check, Minus } from "lucide-react";
import { getGmailConnectionStatus } from "@/actions/gmail";
import { getOutlookConnectionStatus } from "@/actions/outlook";
import { SoonTag } from "@/components/onboarding/onboarding-ui";
import { Button } from "@/components/ui/button";
import type { TourStopId } from "@/lib/tour/tour-stops";
import { cn } from "@/lib/utils";

export type TourFinishFacts = {
  hasApiKey: boolean;
  linkedinRequested: boolean;
  completed: ReadonlySet<TourStopId>;
};

/**
 * The last stop. What the stage set up, what the tour did, and one card for what is still
 * in dry dock. Finishing removes the example people: that is said plainly, along with the
 * fact that anything logged on them goes too.
 */
export function TourFinishCard({
  facts,
  pending,
  onFinish,
}: {
  facts: TourFinishFacts;
  pending: boolean;
  onFinish: () => void;
}) {
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.all([getGmailConnectionStatus(), getOutlookConnectionStatus()])
      .then(([g, o]) => {
        if (!cancelled) setConnected(g.connected || o.connected);
      })
      .catch(() => {
        if (!cancelled) setConnected(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows: Array<{ label: string; done: boolean | null }> = [
    { label: "AI key", done: facts.hasApiKey },
    { label: "LinkedIn export requested", done: facts.linkedinRequested },
    { label: "Google or Microsoft connected", done: connected },
    { label: "Logged an interaction", done: facts.completed.has("contact.log") },
    { label: "Cleared a reminder", done: facts.completed.has("reminders.done") },
    { label: "Asked your network", done: facts.completed.has("chat.ask") },
  ];

  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-[family-name:var(--font-display)] text-xl leading-tight text-ink">
        You’re in orbit
      </h2>
      <p className="text-sm text-muted-foreground">
        That’s every page. The six example people go when you finish, along with anything you
        logged on them. Your own entries stay.
      </p>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-2 text-sm">
            <span
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full border",
                r.done
                  ? "border-tier-lifetime/50 bg-tier-lifetime/10 text-tier-lifetime"
                  : "border-border/80 text-muted-foreground",
              )}
              aria-hidden
            >
              {r.done ? <Check className="size-3" strokeWidth={3} /> : <Minus className="size-3" />}
            </span>
            <span className={r.done ? "text-foreground" : "text-muted-foreground"}>{r.label}</span>
            <span className="sr-only">{r.done ? "done" : "not yet"}</span>
          </li>
        ))}
      </ul>
      <div className="rounded-xl border border-border/70 bg-card/70 p-3 text-xs text-muted-foreground">
        <p className="flex flex-wrap items-center gap-1.5 font-medium text-foreground">
          What’s ahead <SoonTag />
        </p>
        <p className="mt-1">Recruiters, Outreach campaigns and Events, plus a Chrome extension.</p>
      </div>
      <Button type="button" disabled={pending} onClick={onFinish}>
        {pending ? "Finishing…" : "Go to your dashboard"}
        {!pending && <ArrowRight className="size-4" aria-hidden />}
      </Button>
      <p className="text-[11px] text-muted-foreground">
        Anything you skipped waits on your dashboard under Finish setting up.
      </p>
    </div>
  );
}
