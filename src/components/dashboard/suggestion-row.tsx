"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import {
  acceptScoreBump,
  dismissSuggestion,
  scheduleFromSuggestion,
} from "@/actions/reminders";
import { ClosenessTierBadge } from "@/components/dashboard/closeness-tier-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const REASON_LABELS: Record<string, string> = {
  dormant_high_value: "Dormant",
  linkedin_thread_quiet: "LinkedIn quiet",
  post_event: "Post-event",
  score_bump: "Score bump",
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
  tier,
}: {
  id: string;
  suggestionType: string;
  description: string | null;
  contactId: string | null;
  contactName: string;
  contactTitle?: string | null;
  contactCompany?: string | null;
  tier?: "inner" | "mid" | "outer";
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const reasonLabel = REASON_LABELS[suggestionType] ?? "Suggestion";
  const isScoreBump = suggestionType === "score_bump";
  const subtitle = [contactTitle, contactCompany].filter(Boolean).join(" · ");

  return (
    <div className="rounded-xl border border-border/60 bg-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {tier && <ClosenessTierBadge tier={tier} dotOnly />}
            {contactId ? (
              <Link
                href={`/contacts/${contactId}`}
                className="font-medium text-primary hover:underline"
              >
                {contactName}
              </Link>
            ) : (
              <p className="font-medium text-primary">{contactName}</p>
            )}
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                REASON_STYLES[suggestionType] ?? "bg-muted text-muted-foreground"
              )}
            >
              {reasonLabel}
            </span>
          </div>
          {subtitle && (
            <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
          )}
          {description && (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
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
                        err instanceof Error ? err.message : "Could not accept"
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
                      toast.success("Follow-up scheduled in 7 days");
                      router.refresh();
                    } catch (err) {
                      toast.error(
                        err instanceof Error
                          ? err.message
                          : "Could not schedule follow-up"
                      );
                    }
                  })
                }
              >
                Schedule 7d
              </Button>
            )}
            {contactId && (
              <Link
                href={`/contacts/${contactId}`}
                className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-8")}
              >
                Open contact
              </Link>
            )}
          </div>
        </div>
        <Button
          size="icon"
          variant="ghost"
          disabled={pending}
          className="shrink-0"
          onClick={() =>
            start(async () => {
              await dismissSuggestion(id);
              toast.success("Dismissed");
              router.refresh();
            })
          }
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
