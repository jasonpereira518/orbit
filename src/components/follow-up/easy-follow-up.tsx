"use client";

import { useState, useTransition, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import {
  clearContactFollowUp,
  scheduleContactFollowUp,
} from "@/actions/reminders";
import { Button } from "@/components/ui/button";
import { FollowUpDraftSheet } from "@/components/follow-up/follow-up-draft-sheet";
import { promptNotificationsAfterFollowUpAction } from "@/lib/browser-notifications";
import { cn } from "@/lib/utils";

const PRESETS = [
  { days: 3, label: "3d" },
  { days: 7, label: "7d" },
  { days: 14, label: "14d" },
] as const;

export function EasyFollowUp({
  contactId,
  contactName,
  nextFollowUpAt,
  compact = false,
  className,
  onScheduled,
  onCleared,
  onFollowUpClick,
  embedDraftSheet = true,
}: {
  contactId: string;
  contactName?: string;
  nextFollowUpAt?: string | Date | null;
  compact?: boolean;
  className?: string;
  onScheduled?: (dueDate: string) => void;
  onCleared?: () => void;
  /** When set, Follow-up calls this instead of opening the embedded sheet. */
  onFollowUpClick?: () => void;
  /** Render the draft sheet inside this component (disable when hosting sheet outside a Popover). */
  embedDraftSheet?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [sheetOpen, setSheetOpen] = useState(false);

  const displayName = contactName?.trim() || "Contact";

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

  function openFollowUp(e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (onFollowUpClick) {
      onFollowUpClick();
      return;
    }
    setSheetOpen(true);
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
              onClick={openFollowUp}
            >
              Follow-up
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
                  onCleared?.();
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

      {embedDraftSheet && (
        <FollowUpDraftSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          contactId={contactId}
          contactName={displayName}
        />
      )}
    </div>
  );
}
