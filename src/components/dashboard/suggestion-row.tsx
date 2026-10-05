"use client";

import { IntentLink } from "@/components/ui/intent-link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { X } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { companyBrandColor } from "@/lib/company-brand";
import { runToastAction, toast } from "@/lib/toast";
import {
  acceptScoreBump,
  dismissSuggestion,
  restoreSuggestion,
  scheduleFromSuggestion,
} from "@/actions/reminders";
import { ClosenessTierBadge } from "@/components/dashboard/closeness-tier-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";

const REASON_LABELS: Record<string, string> = {
  dormant_high_value: "Dormant",
  linkedin_thread_quiet: "LinkedIn quiet",
  post_event: "Post-event",
  score_bump: "Score bump",
};

/** One line on what acting on each kind of suggestion does, under the reason pill. */
const NEXT_STEP: Record<string, string> = {
  dormant_high_value: "A quick check-in keeps this relationship warm.",
  linkedin_thread_quiet: "Pick the LinkedIn conversation back up.",
  post_event: "Follow up while the introduction is still fresh.",
  score_bump: "Orbit thinks this relationship has grown closer.",
};

const REASON_STYLES: Record<string, string> = {
  dormant_high_value: "bg-amber-500/15 text-amber-800 dark:text-amber-200",
  linkedin_thread_quiet: "bg-sky-500/15 text-sky-800 dark:text-sky-200",
  post_event: "bg-violet-500/15 text-violet-800 dark:text-violet-200",
  score_bump: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200",
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
  const lastTouch =
    lastInteractionAt && !/last (touch|activity)/i.test(description ?? "")
    ? formatDistanceToNow(new Date(lastInteractionAt), { addSuffix: true })
    : null;
  const nextStep = NEXT_STEP[suggestionType];
  const companyColor = companyBrandColor(contactCompany);

  return (
    <div className="rounded-xl border border-border/60 bg-card p-3">
      <div className="flex items-start justify-between gap-3">
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
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                REASON_STYLES[suggestionType] ?? "bg-muted text-muted-foreground"
              )}
            >
              {reasonLabel}
            </span>
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
          {(nextStep || lastTouch) && (
            <p className="mt-1 text-xs text-muted-foreground">
              {nextStep}
              {nextStep && lastTouch ? " " : ""}
              {lastTouch ? `Last touch ${lastTouch}.` : ""}
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
                Accept score
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
                Schedule 7d
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
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
