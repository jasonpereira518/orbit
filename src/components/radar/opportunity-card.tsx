"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { differenceInCalendarDays, format } from "date-fns";
import { Trophy, UserPlus } from "lucide-react";
import { FollowUpDraftSheetLazy, preloadFollowUpDraftSheet } from "@/components/follow-up/follow-up-draft-sheet-lazy";
import { Button } from "@/components/ui/button";
import { DismissMenu } from "@/components/radar/dismiss-menu";
import { ProofChips } from "@/components/radar/proof-chips";
import { dismissRadarOpportunity, saveRadarOpportunity } from "@/actions/radar";
import { friendlyError } from "@/lib/errors";
import { parsePersonTitle } from "@/lib/radar/person-title";
import type { OpportunityView } from "@/lib/radar/opportunity-actions";
import type { RadarDismissReason } from "@/lib/radar/types";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const SAVE_LABEL = { event: "Save to Events", person: "Save person", program: "Remind me", opening: "Save" } as const;

/** A find from the weekly web pass: an event near the person, someone to meet, a program. */
export function OpportunityCard({ find }: { find: OpportunityView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [gone, setGone] = useState(false);
  const [askOpen, setAskOpen] = useState(false);

  const run = (work: () => Promise<{ ok: boolean; message?: string }>, fallback: string) =>
    start(async () => {
      try {
        const result = await work();
        if (!result.ok) {
          toast.error(result.message ?? fallback);
          return;
        }
        setGone(true);
        if (result.message) toast.success(result.message);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, fallback));
      }
    });

  const save = () => run(() => saveRadarOpportunity(find.id), "Couldn’t save that just now — try again?");
  const dismiss = (reason: RadarDismissReason) =>
    run(async () => {
      const r = await dismissRadarOpportunity(find.id, reason);
      return r.ok ? { ok: true, message: "Hidden" } : r;
    }, "Couldn’t hide that — try again?");

  const person = find.kind === "person" ? parsePersonTitle(find.title) : null;
  const starts = find.startsAt ? new Date(find.startsAt) : null;
  const deadline = find.kind === "program" && find.expiresAt ? new Date(find.expiresAt) : null;
  const daysLeft = deadline ? differenceInCalendarDays(deadline, new Date()) : null;
  const introFirst = find.introducer?.name.split(/\s+/)[0] ?? "";

  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-slow ease-house motion-reduce:transition-none",
        gone ? "pointer-events-none grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <article className="rounded-xl border border-border/60 bg-card p-3 sm:p-4" data-opportunity-id={find.id}>
          <div className="flex items-start gap-3">
            {starts ? (
              <div className="w-10 shrink-0 rounded-lg border border-border/70 py-0.5 text-center" suppressHydrationWarning>
                <div className="text-3xs font-medium uppercase text-destructive">{format(starts, "MMM")}</div>
                <div className="text-base font-medium leading-tight text-ink">{format(starts, "d")}</div>
              </div>
            ) : (
              <div
                className={cn(
                  "flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground",
                  person ? "border border-dashed border-border" : "bg-muted"
                )}
                aria-hidden
              >
                {person ? <UserPlus className="size-4" /> : <Trophy className="size-4" />}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-medium text-ink">{person ? person.fullName : find.title}</h3>
                {person && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-3xs font-medium uppercase tracking-wide text-muted-foreground">
                    Not in your network
                  </span>
                )}
              </div>
              {person && (person.title || person.company) && (
                <p className="mt-0.5 text-xs text-muted-foreground">{[person.title, person.company].filter(Boolean).join(" · ")}</p>
              )}
              {find.why && <p className="mt-2 text-sm text-ink">{find.why}</p>}
              {starts && (
                <p className="mt-0.5 text-xs text-muted-foreground" suppressHydrationWarning>
                  {format(starts, "EEEE d MMMM, h:mmaaa")}
                </p>
              )}
              {deadline && daysLeft !== null && (
                <p className="mt-0.5 text-xs text-muted-foreground" suppressHydrationWarning>
                  Closes {format(deadline, "d MMM")} · {daysLeft <= 0 ? "today" : `${daysLeft} ${daysLeft === 1 ? "day" : "days"} left`}
                </p>
              )}
              <ProofChips evidence={find.evidence} />
              <div className="mt-3 flex flex-wrap items-center gap-1.5 pointer-coarse:gap-3">
                {person && find.introducer && (
                  <Button
                    type="button"
                    size="sm"
                    className="h-8"
                    disabled={pending}
                    onPointerEnter={preloadFollowUpDraftSheet}
                    onFocus={preloadFollowUpDraftSheet}
                    onClick={() => setAskOpen(true)}
                  >
                    Ask {introFirst}
                  </Button>
                )}
                <Button type="button" size="sm" variant={person ? "outline" : "default"} className="h-8" disabled={pending} onClick={save}>
                  {SAVE_LABEL[find.kind]}
                </Button>
              </div>
            </div>
            <DismissMenu label={`Hide ${person ? person.fullName : find.title}`} disabled={pending} onDismiss={dismiss} />
          </div>
          {askOpen && person && find.introducer && (
            <FollowUpDraftSheetLazy
              open={askOpen}
              onOpenChange={setAskOpen}
              contactId={find.introducer.contactId}
              contactName={find.introducer.name}
              intent={`Ask for an introduction to ${person.fullName}${person.company ? ` at ${person.company}` : ""}. Short and easy to say no to.`}
              title={`Ask ${introFirst} for an intro`}
              description={`A short note asking for an introduction to ${person.fullName}.`}
            />
          )}
        </article>
      </div>
    </div>
  );
}
