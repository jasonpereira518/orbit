"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import {
  clearContactFollowUp,
  completeContactFollowUp,
  scheduleContactFollowUp,
} from "@/actions/reminders";
import { Button } from "@/components/ui/button";
import { promptNotificationsAfterFollowUpAction } from "@/lib/browser-notifications";
import { cn } from "@/lib/utils";

const PRESETS = [
  { days: 3, label: "3d" },
  { days: 7, label: "7d" },
  { days: 14, label: "14d" },
] as const;

export function EasyFollowUp({
  contactId,
  nextFollowUpAt,
  compact = false,
  className,
  onScheduled,
}: {
  contactId: string;
  nextFollowUpAt?: string | Date | null;
  compact?: boolean;
  className?: string;
  onScheduled?: (dueDate: string) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const dueLabel = nextFollowUpAt
    ? (() => {
        try {
          return new Date(nextFollowUpAt).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          });
        } catch {
          return null;
        }
      })()
    : null;

  const overdue =
    nextFollowUpAt && !Number.isNaN(new Date(nextFollowUpAt).getTime())
      ? new Date(nextFollowUpAt) <= new Date()
      : false;

  function schedule(days: number) {
    start(async () => {
      try {
        const res = await scheduleContactFollowUp(contactId, days);
        onScheduled?.(res.dueDate);
        const permission = await promptNotificationsAfterFollowUpAction();
        if (permission === "granted") {
          toast.success(`Follow-up in ${days} days — desktop alerts on`);
        } else {
          toast.success(`Follow-up set for ${days} days`);
        }
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not set follow-up");
      }
    });
  }

  return (
    <div className={cn("space-y-2", className)}>
      {!compact && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Easy follow-up
          </p>
          {dueLabel && (
            <p
              className={cn(
                "text-xs",
                overdue ? "font-medium text-chart-4" : "text-muted-foreground"
              )}
            >
              {overdue ? "Overdue" : "Due"} {dueLabel}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => (
          <Button
            key={p.days}
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            className="h-8 px-2.5"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              schedule(p.days);
            }}
          >
            {p.label}
          </Button>
        ))}
        {nextFollowUpAt && (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              className="h-8 px-2.5 text-muted-foreground"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                start(async () => {
                  await completeContactFollowUp(contactId);
                  toast.success("Follow-up marked done");
                  router.refresh();
                });
              }}
            >
              Done
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              className="h-8 px-2.5 text-muted-foreground"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                start(async () => {
                  await clearContactFollowUp(contactId);
                  toast.success("Follow-up cleared");
                  router.refresh();
                });
              }}
            >
              Clear
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
