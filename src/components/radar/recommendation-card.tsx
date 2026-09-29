"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { CalendarPlus, Clock, Copy, MoreHorizontal, PenLine, Sparkles, X } from "lucide-react";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { ClosenessTierBadge } from "@/components/dashboard/closeness-tier-badge";
import {
  FollowUpDraftSheetLazy,
  preloadFollowUpDraftSheet,
} from "@/components/follow-up/follow-up-draft-sheet-lazy";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IntentLink } from "@/components/ui/intent-link";
import { integrationHref } from "@/components/settings/sections";
import { explainRecommendationAction } from "@/actions/radar";
import { companyBrandColor } from "@/lib/company-brand";
import { safeHttpUrl } from "@/lib/safe-links";
import { friendlyError } from "@/lib/errors";
import {
  KIND_LABELS,
  type RadarAiNote,
  type RadarDraft,
  type RadarEvidence,
  type RadarReason,
  type RecommendationKind,
} from "@/lib/radar/types";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { KIND_STYLES } from "@/components/radar/kind-styles";
import { useRadarKeys } from "@/components/radar/use-radar-keys";
import { useRecommendationActions } from "@/components/radar/use-recommendation-actions";

/** Reasons that describe the person rather than a fact about now. Shown as quiet chips. */
const CONTEXT_CODES = new Set(["tier", "priority", "stated_close", "target_company", "goal_match"]);
/** Reasons that argue against the card. Kept for the score, never shown. */
const HIDDEN_CODES = new Set(["touched_recently", "dismissed_recently", "already_scheduled"]);

export type RecommendationCardData = {
  id: string;
  contactId: string;
  kind: RecommendationKind;
  reasons: RadarReason[];
  evidence: RadarEvidence[];
  aiNote: RadarAiNote | null;
  /** The AI rerank's one-line "why now". Shown only when there is no fuller note. */
  aiAngle?: string | null;
  /** A message Radar wrote overnight. The sheet opens with it, no model call. */
  draft?: RadarDraft | null;
  contactName: string;
  title: string | null;
  company: string | null;
  tier: "inner" | "mid" | "outer" | null;
  avatarUrl: string | null;
};

const triggerClass =
  "tap-target inline-flex h-8 items-center gap-1.5 rounded-md border border-border/70 px-2.5 text-xs font-medium text-ink transition-colors hover:bg-muted disabled:opacity-50";

export function RecommendationCard({
  rec,
  aiAvailable,
  showAiPrompt,
  shortcuts = false,
}: {
  rec: RecommendationCardData;
  aiAvailable: boolean;
  /** Only Today's cards invite writing a why; the rest stay quiet. */
  showAiPrompt: boolean;
  /** Focus mode's card: `s`, `d`, `z` and `x` act on it. */
  shortcuts?: boolean;
}) {
  const actions = useRecommendationActions(rec);
  const { draftOpen, setDraftOpen } = actions;
  const [writing, start] = useTransition();
  const pending = actions.pending || writing;
  const [note, setNote] = useState<{ why: string; opener: string } | null>(rec.aiNote);

  useRadarKeys(shortcuts && !actions.collapsed, (command) => {
    if (pending) return;
    if (command === "schedule") actions.schedule(7);
    else if (command === "draft") setDraftOpen(true);
    else if (command === "snooze") actions.snooze("1w");
    else if (command === "dismiss") actions.dismiss();
  });

  const facts = rec.reasons.filter((r) => r.points > 0 && !CONTEXT_CODES.has(r.code) && !HIDDEN_CODES.has(r.code));
  const context = rec.reasons.filter((r) => CONTEXT_CODES.has(r.code));
  const also = rec.reasons.filter((r) => r.code.startsWith("also:"));
  const lead = facts[0];
  const evidence = rec.evidence[0];
  const evidenceUrl = safeHttpUrl(evidence?.url);
  const companyColor = companyBrandColor(rec.company);

  const writeWhy = () =>
    start(async () => {
      try {
        const result = await explainRecommendationAction(rec.id);
        if (!result.ok) {
          toast.error(result.message);
          return;
        }
        if (result.why || result.opener) setNote({ why: result.why ?? "", opener: result.opener ?? "" });
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t write that just now — try again?"));
      }
    });

  const schedule = actions.schedule;

  return (
    // Folds away on resolve, and grows back when Undo brings it back: the repo's 0fr→1fr
    // grid-rows collapse, with no transition at all under reduced motion.
    <div
      id={`radar-card-${rec.id}`}
      className={cn(
        "grid scroll-mt-24 transition-[grid-template-rows,opacity] duration-slow ease-house motion-reduce:transition-none",
        actions.collapsed ? "pointer-events-none grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <article className="rounded-xl border border-border/60 bg-card p-3 sm:p-4" data-recommendation-id={rec.id}>
          <div className="flex items-start gap-3">
            <ContactAvatar contactId={rec.contactId} fullName={rec.contactName} profileImageUrl={rec.avatarUrl} size="default" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <IntentLink href={`/contacts/${rec.contactId}`} className="font-medium text-primary hover:underline">
                  {rec.contactName}
                </IntentLink>
                {rec.tier && <ClosenessTierBadge tier={rec.tier} />}
                <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide", KIND_STYLES[rec.kind])}>
                  {KIND_LABELS[rec.kind]}
                </span>
                {rec.draft && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                    Draft ready
                  </span>
                )}
              </div>
              {(rec.title || rec.company) && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {rec.title}
                  {rec.title && rec.company ? " · " : ""}
                  {rec.company && (
                    <span className="font-medium" style={companyColor ? { color: companyColor } : undefined}>
                      {rec.company}
                    </span>
                  )}
                </p>
              )}

              {lead && <p className="mt-2 text-sm text-ink">{lead.label}</p>}
              {facts.slice(1, 3).map((r) => (
                <p key={r.code} className="mt-0.5 text-sm text-ink/80">
                  {r.label}
                </p>
              ))}
              {also.map((r) => (
                <p key={r.code} className="mt-0.5 text-xs text-muted-foreground">
                  Also: {r.label}
                </p>
              ))}

              {(context.length > 0 || evidence) && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  {context.map((r) => (
                    <span key={r.code} className="rounded-full bg-muted px-2 py-0.5">
                      {r.label}
                    </span>
                  ))}
                  {evidence && (
                    <span className="inline-flex items-center gap-1">
                      <Clock className="size-3" aria-hidden />
                      {evidenceUrl ? (
                        // A public source (a headline). The domain stays visible in the label, and
                        // the link is re-checked here rather than trusted from the row.
                        <a
                          href={evidenceUrl}
                          target="_blank"
                          rel="noopener noreferrer nofollow"
                          className="underline decoration-border underline-offset-2 hover:text-ink"
                        >
                          {evidence.label}
                        </a>
                      ) : (
                        evidence.label
                      )}
                      {evidence.at && (
                        <span suppressHydrationWarning>
                          {" · "}
                          {formatDistanceToNow(new Date(evidence.at), { addSuffix: true })}
                        </span>
                      )}
                    </span>
                  )}
                </div>
              )}

              {!(note && (note.why || note.opener)) && rec.aiAngle && (
                <p className="mt-2 flex gap-1.5 text-sm text-ink/80">
                  <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
                  {rec.aiAngle}
                </p>
              )}

              {note && (note.why || note.opener) ? (
                <div className="mt-3 rounded-lg bg-muted/50 p-2.5 text-sm">
                  {note.why && (
                    <p className="flex gap-1.5 text-ink/90">
                      <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
                      {note.why}
                    </p>
                  )}
                  {note.opener && (
                    <div className="mt-1.5 flex items-start justify-between gap-2">
                      <p className="text-muted-foreground">“{note.opener}”</p>
                      <button
                        type="button"
                        aria-label={`Copy opener for ${rec.contactName}`}
                        title="Copy opener"
                        className="tap-target inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-ink"
                        onClick={() => {
                          void navigator.clipboard?.writeText(note.opener).then(
                            () => toast.success("Opener copied"),
                            () => toast.error("Couldn’t copy that — select it instead")
                          );
                        }}
                      >
                        <Copy className="size-3.5" aria-hidden />
                      </button>
                    </div>
                  )}
                </div>
              ) : showAiPrompt ? (
                aiAvailable ? (
                  <button type="button" onClick={writeWhy} disabled={pending} className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50">
                    <Sparkles className="size-3" aria-hidden />
                    Write a one-line why and an opener
                  </button>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    <Link href={integrationHref("ai")} className="text-primary hover:underline">
                      Add an AI key
                    </Link>{" "}
                    for a one-line why and an opener.
                  </p>
                )
              ) : null}

              <div className="mt-3 flex flex-wrap items-center gap-1.5 pointer-coarse:gap-3">
                <DropdownMenu>
                  <DropdownMenuTrigger className={triggerClass} disabled={pending} aria-label={`Schedule a follow-up with ${rec.contactName}`}>
                    <CalendarPlus className="size-3.5" aria-hidden />
                    Schedule
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-44">
                    <DropdownMenuLabel>Follow up in</DropdownMenuLabel>
                    <DropdownMenuItem onClick={() => schedule(3)}>3 days</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => schedule(7)}>1 week</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => schedule(14)}>2 weeks</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8"
                  disabled={pending}
                  onPointerEnter={preloadFollowUpDraftSheet}
                  onFocus={preloadFollowUpDraftSheet}
                  onClick={() => setDraftOpen(true)}
                >
                  <PenLine className="size-3.5" aria-hidden />
                  {rec.draft ? "Review draft" : "Draft message"}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger className={triggerClass} disabled={pending} aria-label={`Snooze ${rec.contactName}`}>
                    <Clock className="size-3.5" aria-hidden />
                    Snooze
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-40">
                    <DropdownMenuItem onClick={() => actions.snooze("1w")}>For a week</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => actions.snooze("1m")}>For a month</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label={`More actions for ${rec.contactName}`}
                    title="More actions"
                    disabled={pending}
                    className="tap-target relative inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-ink"
                  >
                    <MoreHorizontal className="size-4" aria-hidden />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuItem render={<Link href={`/contacts/${rec.contactId}`} />}>Open contact</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={actions.never}>
                      Not for this person
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Dismiss the suggestion about ${rec.contactName}`}
              disabled={pending}
              className="shrink-0"
              onClick={actions.dismiss}
            >
              <X className="size-4" aria-hidden />
            </Button>
          </div>
          {draftOpen && (
            <FollowUpDraftSheetLazy
              open={draftOpen}
              onOpenChange={setDraftOpen}
              contactId={rec.contactId}
              contactName={rec.contactName}
              initialDraft={rec.draft?.body}
            />
          )}
        </article>
      </div>
    </div>
  );
}
