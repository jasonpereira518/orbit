"use client";

import { useEffect, useState, useTransition, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { runToastAction, toast } from "@/lib/toast";
import {
  clearContactFollowUp,
  markKeepInTouchDone,
  scheduleContactFollowUp,
  undoKeepInTouchDoneAction,
} from "@/actions/reminders";
import { Button } from "@/components/ui/button";
import {
  FollowUpDraftSheetLazy,
  preloadFollowUpDraftSheet,
} from "@/components/follow-up/follow-up-draft-sheet-lazy";
import { promptNotificationsAfterFollowUpAction } from "@/lib/browser-notifications";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import {
  FOLLOW_UP_PRESETS,
  browserTimeZone,
  followUpSetMessage,
  resolvePreset,
  type FollowUpPresetId,
} from "@/lib/follow-up-presets";

export function EasyFollowUp({
  contactId,
  contactName,
  nextFollowUpAt,
  dueByCadence = false,
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
  /** Due because the keep-in-touch cadence lapsed, with nothing booked: offer Follow up and Done. */
  dueByCadence?: boolean;
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
  const [confirmClear, setConfirmClear] = useState(false);

  // An armed confirm is a question, and an unanswered question should expire rather
  // than sit there waiting to catch a later, unrelated click on the same spot.
  useEffect(() => {
    if (!confirmClear) return;
    const t = window.setTimeout(() => setConfirmClear(false), 4000);
    return () => window.clearTimeout(t);
  }, [confirmClear]);

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

  function schedule(id: FollowUpPresetId) {
    const due = resolvePreset(id, new Date(), browserTimeZone());
    start(async () => {
      try {
        const res = await scheduleContactFollowUp(contactId, due.toISOString());
        onScheduled?.(res.dueDate);
        const permission = await promptNotificationsAfterFollowUpAction();
        toast.success(
          permission === "granted" ? `${followUpSetMessage(due)} — desktop alerts are on` : followUpSetMessage(due)
        );
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t set that follow-up — try again?"));
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

      {/* Hierarchy, in the order a user actually wants them:
          1. Follow-up  — the goal. Doing the thing. Was the WEAKEST control here.
          2. Remind in… — postpone. Lowest stakes, and was the LOUDEST (outline).
          3. Clear      — destructive: it also closes every pending reminder for
                          this contact. Was a ghost button with no confirmation. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {(nextFollowUpAt || dueByCadence) && (
          <Button
            type="button"
            size="sm"
            disabled={pending}
            className="h-8 px-2.5"
            // Warm the draft sheet's code on the way to the click, so it opens at once.
            onPointerEnter={preloadFollowUpDraftSheet}
            onFocus={preloadFollowUpDraftSheet}
            onClick={openFollowUp}
          >
            Follow up
          </Button>
        )}

        {dueByCadence && !nextFollowUpAt && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            className="h-8 px-2.5"
            title="Mark as kept in touch"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              start(() =>
                runToastAction({
                  run: () => markKeepInTouchDone(contactId),
                  success: "Marked done",
                  failure: "Couldn’t mark that done — try again?",
                  refresh: () => router.refresh(),
                  undo: (snap) => () => undoKeepInTouchDoneAction(snap),
                }).then(() => undefined)
              );
            }}
          >
            Done
          </Button>
        )}

        {/* "3d" alone reads as "3 days from the due date", which is not what these
            do — they schedule N days from TODAY. On a row saying "Overdue 31 days"
            those are opposite outcomes, so the group is labelled rather than left
            to be guessed at. */}
        <span className="ml-0.5 text-xs text-muted-foreground">Remind in</span>
        {(compact ? FOLLOW_UP_PRESETS.slice(0, 4) : FOLLOW_UP_PRESETS).map((p) => (
          <Button
            key={p.id}
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            className="h-8 px-2.5"
            title={p.label}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              schedule(p.id);
            }}
          >
            {p.short}
          </Button>
        ))}

        {nextFollowUpAt && (
          <Button
            type="button"
            size="sm"
            variant={confirmClear ? "destructive" : "ghost"}
            disabled={pending}
            className="h-8 px-2.5 text-muted-foreground aria-pressed:text-destructive"
            aria-pressed={confirmClear}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              // Two-step, because this is not just "clear the date": it marks every
              // pending reminder for the contact done and completes their linked
              // action items. One stray click used to do all of that silently.
              if (!confirmClear) {
                setConfirmClear(true);
                return;
              }
              start(async () => {
                const res = await clearContactFollowUp(contactId);
                setConfirmClear(false);
                onCleared?.();
                toast.success(
                  res.remindersClosed > 0
                    ? `Follow-up cleared · ${res.remindersClosed} reminder${
                        res.remindersClosed === 1 ? "" : "s"
                      } closed`
                    : "Follow-up cleared"
                );
                router.refresh();
              });
            }}
          >
            {confirmClear ? "Clear it?" : "Clear"}
          </Button>
        )}
      </div>

      {embedDraftSheet && (
        <FollowUpDraftSheetLazy
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          contactId={contactId}
          contactName={displayName}
        />
      )}
    </div>
  );
}
