"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookmarkPlus, CalendarPlus, CheckCircle2, Clock, Copy, MessageSquare, MoreHorizontal, PenLine, Sparkles, Users } from "lucide-react";
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
import { AiKeyNotice } from "@/components/ai-key-notice";
import { advanceDoubleOptInIntro, explainRecommendationAction, trackRadarOpportunity } from "@/actions/radar";
import { companyBrandText } from "@/lib/company-brand";
import { friendlyError } from "@/lib/errors";
import { aiDenialFromMessage } from "@/lib/ai-access-copy";
import type { AiAccessDenial } from "@/lib/managed-ai-policy";
import {
  JOB_MOVE_CODE,
  KIND_LABELS,
  draftIntent,
  leadReason,
  type RadarAiNote,
  type RadarCalendarInvite,
  type RadarDraft,
  type RadarEvidence,
  type RadarPlayState,
  type RadarPlayType,
  type RadarReason,
  type RecommendationBucket,
  type RecommendationKind,
} from "@/lib/radar/types";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { KIND_STYLES } from "@/components/radar/kind-styles";
import { DismissMenu } from "@/components/radar/dismiss-menu";
import { ProofChips } from "@/components/radar/proof-chips";
import { useRadarKeys } from "@/components/radar/use-radar-keys";
import { useRecommendationActions } from "@/components/radar/use-recommendation-actions";

/** Reasons that describe the person rather than a fact about now. Shown as quiet chips. */
const CONTEXT_CODES = new Set(["tier", "priority", "stated_close", "target_company", "goal_match", "focus_match"]);
/** Reasons that argue against the card. Kept for the score, never shown. */
const HIDDEN_CODES = new Set(["touched_recently", "dismissed_recently", "already_scheduled"]);

export type RecommendationCardData = {
  id: string;
  contactId: string;
  kind: RecommendationKind;
  /** "today": a moment that won't keep (`week.ts`), shown in the Today strip. */
  bucket?: RecommendationBucket | null;
  score?: number;
  reasons: RadarReason[];
  evidence: RadarEvidence[];
  aiNote: RadarAiNote | null;
  /** The AI rerank's one-line "why now". Shown only when there is no fuller note. */
  aiAngle?: string | null;
  /** A message Radar wrote overnight. The sheet opens with it, no model call. */
  draft?: RadarDraft | null;
  /** Suggested calendar invite for 1-click execution */
  suggestedCalendarInvite?: RadarCalendarInvite | null;
  secondaryContactId?: string | null;
  secondaryContactName?: string | null;
  playType?: RadarPlayType | null;
  playState?: RadarPlayState | null;
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
  const router = useRouter();
  const actions = useRecommendationActions(rec);
  const { draftOpen, setDraftOpen } = actions;
  const [writing, start] = useTransition();
  const [playPending, startPlay] = useTransition();
  const pending = actions.pending || writing || playPending;
  const [note, setNote] = useState<{ why: string; opener: string; nextStep?: string; talkingPoints?: string[] } | null>(rec.aiNote);
  const [playStep, setPlayStep] = useState<RadarPlayState["step"] | undefined>(rec.playState?.step);
  // Kept with the `aiAvailable` it was seen under, so the notice resets when access changes
  // (a key added, credits refilled) without a setState in an effect.
  const [refusal, setRefusal] = useState<{ reason: AiAccessDenial; aiAvailable: boolean } | null>(null);
  const denial = refusal && refusal.aiAvailable === aiAvailable ? refusal.reason : null;

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
  const congrats = lead?.code === JOB_MOVE_CODE;
  const draftLabel = rec.draft ? "Review draft" : congrats ? "Congratulate" : rec.kind === "introduce" ? "Draft intro" : "Draft message";
  const companyBrand = companyBrandText(rec.company);

  const writeWhy = () =>
    start(async () => {
      try {
        const result = await explainRecommendationAction(rec.id);
        if (!result.ok) {
          const d = aiDenialFromMessage(result.message);
          if (d) setRefusal({ reason: d, aiAvailable });
          else toast.error(result.message);
          return;
        }
        setRefusal(null);
        if (result.why || result.opener) setNote({ why: result.why ?? "", opener: result.opener ?? "" });
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t write that just now — try again?"));
      }
    });

    const schedule = actions.schedule;
  const firstName = rec.contactName.split(/\s+/)[0] || rec.contactName;
  const secondaryFirst = rec.secondaryContactName?.split(/\s+/)[0] || rec.secondaryContactName;
  const isDoubleOptIn = rec.playType === "double_opt_in_intro" && Boolean(rec.secondaryContactName);

  const advancePlay = (next: RadarPlayState["step"]) =>
    startPlay(async () => {
      try {
        const res = await advanceDoubleOptInIntro(rec.id, next);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        setPlayStep(next);
        toast.success(
          next === "awaiting_opt_in"
            ? "Marked awaiting reply — 4-day follow-up set"
            : next === "completed"
              ? "Intro completed"
              : "Intro step updated"
        );
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t update intro step — try again?"));
      }
    });

  const trackOpportunity = () =>
    startPlay(async () => {
      try {
        const res = await trackRadarOpportunity({ source: "recommendation", id: rec.id });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        if (res.message) toast.success(res.message);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t track opportunity — try again?"));
      }
    });

  const askOrbitPrompt = encodeURIComponent(
    `Help me prepare for reaching out to ${rec.contactName}${rec.company ? ` (${rec.company})` : ""} about: ${rec.aiAngle ?? lead?.label ?? KIND_LABELS[rec.kind]}`
  );

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
                <span className={cn("rounded-full px-2 py-0.5 text-3xs font-medium uppercase tracking-wide", KIND_STYLES[rec.kind])}>
                  {KIND_LABELS[rec.kind]}
                </span>
                {rec.draft && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-3xs font-medium uppercase tracking-wide text-primary">
                    Draft ready
                  </span>
                )}
                {rec.secondaryContactName && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-teal-500/15 px-2 py-0.5 text-3xs font-medium text-teal-800 dark:text-teal-200">
                    <Users className="size-3" aria-hidden />
                    {rec.secondaryContactId ? (
                      <IntentLink href={`/contacts/${rec.secondaryContactId}`} className="hover:underline">
                        Pair: {rec.secondaryContactName}
                      </IntentLink>
                    ) : (
                      <span>Pair: {rec.secondaryContactName}</span>
                    )}
                  </span>
                )}
              </div>
              {(rec.title || rec.company) && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {rec.title}
                  {rec.title && rec.company ? " · " : ""}
                  {rec.company && (
                    <span className={cn("font-medium", companyBrand?.className)} style={companyBrand?.style}>
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

              {context.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  {context.map((r) => (
                    <span key={r.code} className="rounded-full bg-muted px-2 py-0.5">
                      {r.label}
                    </span>
                  ))}
                </div>
              )}
              <ProofChips evidence={rec.evidence} />

              {!(note && (note.why || note.opener)) && rec.aiAngle && (
                <p className="mt-2 flex gap-1.5 text-sm text-ink/80">
                  <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
                  {rec.aiAngle}
                </p>
              )}

              {note && (note.why || note.opener || note.nextStep || (note.talkingPoints && note.talkingPoints.length > 0)) ? (
                <div className="mt-3 rounded-lg bg-muted/50 p-2.5 text-sm">
                  {note.why && (
                    <p className="flex gap-1.5 text-ink/90">
                      <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
                      {note.why}
                    </p>
                  )}
                  {note.nextStep && (
                    <p className="mt-1.5 text-xs font-medium text-ink/85">
                      Next step: <span className="font-normal text-muted-foreground">{note.nextStep}</span>
                    </p>
                  )}
                  {note.talkingPoints && note.talkingPoints.length > 0 && (
                    <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                      {note.talkingPoints.map((tp) => (
                        <li key={tp}>{tp}</li>
                      ))}
                    </ul>
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
                denial ? (
                  <div className="mt-2">
                    <AiKeyNotice feature="draft" reason={denial} compact />
                  </div>
                ) : aiAvailable ? (
                  <button type="button" onClick={writeWhy} disabled={pending} className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50">
                    <Sparkles className="size-3" aria-hidden />
                    Write a one-line why and an opener
                  </button>
                ) : null
              ) : null}

                {isDoubleOptIn && (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5 rounded-lg border border-teal-500/25 bg-teal-500/5 px-2.5 py-2 text-xs">
                    <span className="font-medium text-teal-900 dark:text-teal-200">
                      Double opt-in play
                    </span>
                    <span className="text-muted-foreground">·</span>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => advancePlay("draft_opt_in")}
                      className={cn(
                        "rounded px-2 py-0.5 transition-colors",
                        !playStep || playStep === "draft_opt_in"
                          ? "bg-teal-600/15 font-medium text-teal-900 dark:text-teal-200"
                          : "text-muted-foreground hover:text-ink"
                      )}
                    >
                      1. Ask {firstName}
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => advancePlay("awaiting_opt_in")}
                      className={cn(
                        "rounded px-2 py-0.5 transition-colors",
                        playStep === "awaiting_opt_in"
                          ? "bg-teal-600/15 font-medium text-teal-900 dark:text-teal-200"
                          : "text-muted-foreground hover:text-ink"
                      )}
                    >
                      2. Awaiting reply
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => advancePlay("draft_intro")}
                      className={cn(
                        "rounded px-2 py-0.5 transition-colors",
                        playStep === "draft_intro"
                          ? "bg-teal-600/15 font-medium text-teal-900 dark:text-teal-200"
                          : "text-muted-foreground hover:text-ink"
                      )}
                    >
                      3. Intro {secondaryFirst}
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => advancePlay("completed")}
                      className={cn(
                        "inline-flex items-center gap-1 rounded px-2 py-0.5 transition-colors",
                        playStep === "completed"
                          ? "bg-emerald-600/15 font-medium text-emerald-800 dark:text-emerald-200"
                          : "text-muted-foreground hover:text-ink"
                      )}
                    >
                      <CheckCircle2 className="size-3" aria-hidden />
                      4. Done
                    </button>
                  </div>
                )}

              <div className="mt-3 flex flex-wrap items-center gap-1.5 pointer-coarse:gap-3">
                {rec.suggestedCalendarInvite && (
                  <Button
                    type="button"
                    size="sm"
                    variant="default"
                    className="h-8 gap-1.5"
                    disabled={pending}
                    onClick={() => actions.confirmInvite()}
                    title={`Send calendar invite for ${new Date(rec.suggestedCalendarInvite.proposedStartTime).toLocaleDateString()}`}
                  >
                    <CalendarPlus className="size-3.5" aria-hidden />
                    1-Click Invite
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant={rec.suggestedCalendarInvite ? "outline" : "default"}
                  className="h-8"
                  disabled={pending}
                  onPointerEnter={preloadFollowUpDraftSheet}
                  onFocus={preloadFollowUpDraftSheet}
                  onClick={() => setDraftOpen(true)}
                >
                  <PenLine className="size-3.5" aria-hidden />
                  {draftLabel}
                </Button>
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
                    <DropdownMenuItem render={<Link href={`/chat?q=${askOrbitPrompt}`} />}>
                      <MessageSquare className="size-3.5" aria-hidden />
                      Ask Orbit about this
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={trackOpportunity}>
                      <BookmarkPlus className="size-3.5" aria-hidden />
                      Track opportunity
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={actions.never}>
                      Not for this person
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <DismissMenu
              label={`Dismiss the suggestion about ${rec.contactName}`}
              disabled={pending}
              onDismiss={(reason) => actions.dismiss(reason)}
            />
          </div>
          {draftOpen && <RecommendationDraftSheet rec={rec} actions={actions} />}
        </article>
      </div>
    </div>
  );
}

/**
 * The draft sheet as a card opens it: told why the card exists, so a fallback draft or a
 * Regenerate is about that and not a generic follow-up. A new job reads as a congratulation.
 * A sent email folds the card away (the send retires it server-side once it goes out), and
 * the toast's Undo brings it back.
 */
export function RecommendationDraftSheet({
  rec,
  actions,
}: {
  rec: RecommendationCardData;
  actions: ReturnType<typeof useRecommendationActions>;
}) {
  const congrats = leadReason(rec.reasons)?.code === JOB_MOVE_CODE;
  const firstName = rec.contactName.split(/\s+/)[0] || rec.contactName;
  return (
    <FollowUpDraftSheetLazy
      open={actions.draftOpen}
      onOpenChange={actions.setDraftOpen}
      contactId={rec.contactId}
      contactName={rec.contactName}
      initialDraft={rec.draft?.body}
      intent={draftIntent(rec)}
      onSent={actions.hide}
      onUndone={actions.unhide}
      {...(congrats && {
        title: `Congratulate ${firstName}`,
        description: "A short note on the new role, then send it or mark it sent.",
        subject: rec.company ? `Congrats on ${rec.company}` : "Congrats on the new role",
      })}
    />
  );
}
