"use client";

import Link from "next/link";
import { ArrowRight, CalendarPlus, PenLine, Radar, X } from "lucide-react";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { preloadFollowUpDraftSheet } from "@/components/follow-up/follow-up-draft-sheet-lazy";
import { RecommendationDraftSheet, type RecommendationCardData } from "@/components/radar/recommendation-card";
import { useRecommendationActions } from "@/components/radar/use-recommendation-actions";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IntentLink } from "@/components/ui/intent-link";
import { cardLine, type ChangeLine } from "@/lib/radar/briefing";
import { KIND_LABELS } from "@/lib/radar/types";
import { cn } from "@/lib/utils";

export type MorningBriefingProps = {
  items: RecommendationCardData[];
  /** Everyone on Radar's list. */
  total: number;
  /** Today's section on `/radar`. */
  today: number;
  drafts: number;
  changes: ChangeLine[];
  paused: boolean;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The dashboard's hero for viewers who can open Radar: today's first few people with the
 * three actions that settle most of them (draft, schedule, dismiss), how many drafts are
 * waiting, and what changed overnight. Everything else is one click away on `/radar`.
 */
export function MorningBriefing({ items, total, today, drafts, changes, paused }: MorningBriefingProps) {
  const headline = today > 0 ? `${plural(today, "person", "people")} worth a message today` : "All clear today";
  const sub = [
    drafts > 0 ? `${plural(drafts, "draft", "drafts")} ready to review` : null,
    total > today ? `${total - today} more this week` : null,
    paused ? "Radar is paused" : null,
  ].filter(Boolean);

  return (
    <section aria-labelledby="radar-briefing-title">
      <Card className="border-border/70 shadow-none">
        <CardContent className="space-y-4 p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                <Radar className="size-3.5 text-primary" aria-hidden />
                Radar
              </p>
              <h2 id="radar-briefing-title" className="mt-1 font-[family-name:var(--font-display)] text-xl text-ink sm:text-2xl">
                {headline}
              </h2>
              {sub.length > 0 && <p className="mt-0.5 text-sm text-muted-foreground">{sub.join(" · ")}</p>}
            </div>
            <Link href="/radar" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}>
              Open Radar <ArrowRight className="ml-1 size-3.5" aria-hidden />
            </Link>
          </div>

          {(items.length > 0 || changes.length > 0) && (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              {items.length > 0 && (
                <ul className="space-y-2" aria-label="Today’s first people">
                  {items.map((rec) => (
                    <BriefingRow key={rec.id} rec={rec} />
                  ))}
                </ul>
              )}
              {changes.length > 0 && (
                <section aria-labelledby="radar-briefing-changed" className="min-w-0 rounded-xl bg-muted/40 p-3">
                  <h3 id="radar-briefing-changed" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    What changed overnight
                  </h3>
                  <ul className="mt-1.5 space-y-1.5">
                    {changes.map((c) => (
                      <li key={c.id} className="min-w-0 text-sm">
                        <Link href={`/radar?focus=${encodeURIComponent(c.id)}`} className="line-clamp-2 text-ink/90 hover:text-ink hover:underline">
                          <span className="font-medium text-ink">{c.contactName}</span>
                          <span className="text-muted-foreground"> · </span>
                          {c.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

const iconButton =
  "tap-target inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-ink disabled:opacity-50";

/** One person, compact: who, the one line of why, and draft / schedule / dismiss. */
function BriefingRow({ rec }: { rec: RecommendationCardData }) {
  const actions = useRecommendationActions(rec);
  const line = cardLine(rec);
  return (
    <li
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-slow ease-house motion-reduce:transition-none",
        actions.collapsed ? "pointer-events-none grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-card px-2.5 py-2.5 sm:gap-3 sm:px-3">
          <ContactAvatar contactId={rec.contactId} fullName={rec.contactName} profileImageUrl={rec.avatarUrl} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <IntentLink href={`/contacts/${rec.contactId}`} className="truncate text-sm font-medium text-primary hover:underline">
                {rec.contactName}
              </IntentLink>
              <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">{KIND_LABELS[rec.kind]}</span>
            </div>
            {/* On a phone the kind moves down here, so the name gets the row's width. */}
            <p className={cn("truncate text-xs text-muted-foreground", !line && "sm:hidden")}>
              <span className="sm:hidden">
                {KIND_LABELS[rec.kind]}
                {line ? " · " : ""}
              </span>
              {line}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant={rec.draft ? "default" : "outline"}
            className="h-8 shrink-0"
            disabled={actions.pending}
            onPointerEnter={preloadFollowUpDraftSheet}
            onFocus={preloadFollowUpDraftSheet}
            onClick={() => actions.setDraftOpen(true)}
            aria-label={rec.draft ? `Review draft for ${rec.contactName}` : `Draft a message to ${rec.contactName}`}
          >
            <PenLine className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">{rec.draft ? "Review draft" : "Draft"}</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger className={iconButton} disabled={actions.pending} aria-label={`Schedule a follow-up with ${rec.contactName}`}>
              <CalendarPlus className="size-4" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel>Follow up in</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => actions.schedule(3)}>3 days</DropdownMenuItem>
              <DropdownMenuItem onClick={() => actions.schedule(7)}>1 week</DropdownMenuItem>
              <DropdownMenuItem onClick={() => actions.schedule(14)}>2 weeks</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            className={iconButton}
            disabled={actions.pending}
            aria-label={`Dismiss the suggestion about ${rec.contactName}`}
            onClick={actions.dismiss}
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      </div>
      {actions.draftOpen && <RecommendationDraftSheet rec={rec} actions={actions} />}
    </li>
  );
}
