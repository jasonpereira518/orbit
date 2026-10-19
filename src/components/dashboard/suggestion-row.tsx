"use client";

import { IntentLink } from "@/components/ui/intent-link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { X } from "lucide-react";
import { companyBrandColor } from "@/lib/company-brand";
import { runToastAction, toast } from "@/lib/toast";
import {
  acceptScoreBump,
  dismissSuggestion,
  restoreSuggestion,
  scheduleFromSuggestion,
} from "@/actions/reminders";
import { ClosenessTierBadge } from "@/components/dashboard/closeness-tier-badge";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RelativeTime } from "@/components/ui/relative-time";
import type { Tone } from "@/lib/tone";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";

const REASON_LABELS: Record<string, string> = {
  // `JOB_CHANGE_SUGGESTION_TYPE` in lib/job-changes.ts (not imported: it reaches the db).
  job_change_congrats: "New role",
  awaiting_reply: "No reply yet",
  keep_in_touch: "Keep in touch",
  dormant_high_value: "Dormant",
  linkedin_thread_quiet: "LinkedIn quiet",
  post_event: "Post-event",
  score_bump: "Score bump",
};

/** One line on what acting on each kind of suggestion does, under the reason pill. */
const NEXT_STEP: Record<string, string> = {
  job_change_congrats: "A short congratulations lands best in the first few weeks.",
  dormant_high_value: "A quick check-in keeps this relationship warm.",
  linkedin_thread_quiet: "Pick the LinkedIn conversation back up.",
  post_event: "Follow up while the introduction is still fresh.",
  score_bump: "Orbit thinks this relationship has grown closer.",
};

/**
 * The reason chip's tone — the same palette Radar's kind chips use (`radar/kind-styles.ts`),
 * so a colour means one thing on both cards: quiet/dormant is neutral, news is info, a debt
 * you owe is warning, a fresh opening is accent.
 */
const REASON_TONES: Record<string, Tone> = {
  job_change_congrats: "info",
  awaiting_reply: "warning",
  keep_in_touch: "neutral",
  dormant_high_value: "neutral",
  linkedin_thread_quiet: "neutral",
  post_event: "accent",
  score_bump: "success",
};

export function SuggestionRow({
  id,
  suggestionType,
  description,
  contactId,
  contactName,
  contactTitle,
  contactCompany,
  lastInteractionAt,
  tier,
}: {
  id: string;
  suggestionType: string;
  description: string | null;
  contactId: string | null;
  contactName: string;
  contactTitle?: string | null;
  contactCompany?: string | null;
  lastInteractionAt?: Date | string | null;
  tier?: "inner" | "mid" | "outer";
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const reasonLabel = REASON_LABELS[suggestionType] ?? "Suggestion";
  const isScoreBump = suggestionType === "score_bump";
  // Dormant and quiet-thread descriptions already state how long it has been.
  const showLastTouch = Boolean(lastInteractionAt) && !/last (touch|activity)/i.test(description ?? "");
  const nextStep = NEXT_STEP[suggestionType];
  const companyColor = companyBrandColor(contactCompany);

  return (
    <Card size="sm">
      <CardContent className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {contactId ? (
              <IntentLink
                href={`/contacts/${contactId}`}
                className="font-medium text-primary hover:underline"
              >
                {contactName}
              </IntentLink>
            ) : (
              <p className="font-medium text-ink">{contactName}</p>
            )}
            {tier && <ClosenessTierBadge tier={tier} />}
            <Badge tone={REASON_TONES[suggestionType] ?? "neutral"} size="sm">
              {reasonLabel}
            </Badge>
          </div>
          {(contactTitle || contactCompany) && (
            <p className="mt-0.5 text-sm">
              {contactCompany && (
                <span
                  className="font-semibold"
                  style={companyColor ? { color: companyColor } : undefined}
                >
                  {contactCompany}
                </span>
              )}
              {contactTitle && contactCompany ? (
                <span className="text-muted-foreground"> · </span>
              ) : null}
              {contactTitle && (
                <span className="text-xs text-muted-foreground">{contactTitle}</span>
              )}
            </p>
          )}
          {description && (
            <p className="mt-1.5 text-sm text-ink/80">{description}</p>
          )}
          {(nextStep || showLastTouch) && (
            <p className="mt-1 text-xs text-muted-foreground">
              {nextStep}
              {nextStep && showLastTouch ? " " : ""}
              {showLastTouch && lastInteractionAt ? (
                <>
                  Last interaction <RelativeTime date={lastInteractionAt} />.
                </>
              ) : null}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {isScoreBump ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending}
                className="h-8"
                onClick={() =>
                  start(async () => {
                    try {
                      await acceptScoreBump(id);
                      toast.success("Relationship score updated");
                      router.refresh();
                    } catch (err) {
                      toast.error(
                        friendlyError(err, "Couldn’t accept that — try again?")
                      );
                    }
                  })
                }
              >
                {pending ? "Saving…" : "Accept score"}
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending || !contactId}
                className="h-8"
                onClick={() =>
                  start(async () => {
                    try {
                      await scheduleFromSuggestion(id, 7);
                      toast.success("Follow-up set for a week from now");
                      router.refresh();
                    } catch (err) {
                      toast.error(
                        friendlyError(err, "Couldn’t schedule that follow-up — try again?")
                      );
                    }
                  })
                }
              >
                {pending ? "Saving…" : "Snooze 7 days"}
              </Button>
            )}
            {contactId && (
              <IntentLink
                href={`/contacts/${contactId}`}
                className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-8")}
              >
                Open contact
              </IntentLink>
            )}
          </div>
        </div>
        <Button
          size="icon"
          variant="ghost"
          aria-label={`Dismiss suggestion for ${contactName}`}
          disabled={pending}
          className="shrink-0"
          onClick={() =>
            start(() =>
              runToastAction({
                run: () => dismissSuggestion(id),
                success: "Dismissed",
                failure: "Couldn’t dismiss that — try again?",
                refresh: () => router.refresh(),
                undo: () => () => restoreSuggestion(id),
              }).then(() => undefined)
            )
          }
        >
          <X className="size-4" aria-hidden />
        </Button>
      </CardContent>
    </Card>
  );
}
