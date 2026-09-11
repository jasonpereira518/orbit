"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Check, Clock, MoreHorizontal, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  deleteReminderAction,
  markReminderDone,
  reopenReminderAction,
  restoreReminderAction,
  snoozeReminderAction,
} from "@/actions/reminders";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Per-reminder controls.
 *
 * `size="icon-sm"` and `h-3.5` glyphs to match the edit pencil next to them in
 * `reminder-card.tsx`. These read as one set but were not one: the pencil
 * was `icon-sm` with a 3.5 glyph while these were `icon` with a 4.
 *
 * `title` as well as `aria-label`, so the snooze amount is discoverable by
 * pointer too — it was previously only reachable by screen reader or by clicking
 * and reading the toast. Native `title` rather than the Tooltip component on
 * purpose: this is a hint on a dense row, and the repo already uses `title` for
 * exactly this (`layout/app-sidebar.tsx`, `dashboard/closeness-tier-badge.tsx`).
 *
 * Two gaps this closes:
 *
 *   - There was no delete. Completing was the only way to clear a row, which
 *     conflates "I did this" with "this should not have been here" and left the
 *     Done tab as a permanent record of both.
 *   - There was no reopen. Pressing the clock on a completed reminder silently
 *     un-completed it, because `snoozeReminder` sets `status: "pending"` while
 *     rescheduling — so the only route back from Done was a control labelled
 *     "Snooze 7 days" that also moved the date a week out.
 *
 * Destructive and rare actions sit behind the overflow menu; the one action that
 * matches the current state stays on the row.
 */
export function ReminderDoneSnooze({
  id,
  status = "pending",
}: {
  id: string;
  /** "done" and the legacy "completed" both render the reopen affordance. */
  status?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const isDone = status === "done" || status === "completed";

  return (
    <div className="flex gap-1">
      {isDone ? (
        <Button
          size="icon-sm"
          variant="ghost"
          disabled={pending}
          aria-label="Reopen reminder"
          title="Reopen reminder"
          onClick={() =>
            start(async () => {
              await reopenReminderAction(id);
              toast.success("Reopened");
              router.refresh();
            })
          }
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      ) : (
        <>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={pending}
            aria-label="Mark done"
            title="Mark done"
            onClick={() =>
              start(async () => {
                await markReminderDone(id);
                toast.success("Marked done");
                router.refresh();
              })
            }
          >
            <Check className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={pending}
            aria-label="Snooze 7 days"
            title="Snooze 7 days"
            onClick={() =>
              start(async () => {
                await snoozeReminderAction(id, 7);
                toast.success("Snoozed 7 days");
                router.refresh();
              })
            }
          >
            <Clock className="h-3.5 w-3.5" />
          </Button>
        </>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={pending}
              aria-label="More reminder actions"
              title="More"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            variant="destructive"
            onClick={() =>
              start(async () => {
                const res = await deleteReminderAction(id);
                router.refresh();
                // The snapshot is what makes this undo real. Deleting something a
                // person wrote is exactly where an undo has to exist, and there is
                // no other copy of the title, note or date once the row is gone.
                toast.success("Reminder deleted", {
                  action: {
                    label: "Undo",
                    onClick: () =>
                      start(async () => {
                        await restoreReminderAction(res.snapshot);
                        toast.success("Reminder restored");
                        router.refresh();
                      }),
                  },
                });
              })
            }
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
