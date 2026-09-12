"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Check, Clock } from "lucide-react";
import { runToastAction } from "@/lib/toast";
import {
  markReminderDone,
  reopenReminderAction,
  snoozeReminderAction,
  unsnoozeReminderAction,
} from "@/actions/reminders";
import { Button } from "@/components/ui/button";

/**
 * Done / snooze, as icon buttons.
 *
 * `size="icon-sm"` and `h-3.5` glyphs to match the edit pencil next to them in
 * `reminder-card.tsx`. These three read as one set but were not one: the pencil
 * was `icon-sm` with a 3.5 glyph while these two were `icon` with a 4.
 *
 * `title` as well as `aria-label`, so the snooze amount is discoverable by
 * pointer too — it was previously only reachable by screen reader or by clicking
 * and reading the toast. Native `title` rather than the Tooltip component on
 * purpose: this is a hint on a dense row, and the repo already uses `title` for
 * exactly this (`layout/app-sidebar.tsx`, `dashboard/closeness-tier-badge.tsx`).
 */
export function ReminderDoneSnooze({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <div className="flex gap-1">
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={pending}
        aria-label="Mark done"
        title="Mark done"
        onClick={() =>
          start(() =>
            runToastAction({
              run: () => markReminderDone(id),
              success: "Marked done",
              failure: "Couldn’t mark that done — try again?",
              refresh: () => router.refresh(),
              undo: (snap) => (snap ? () => reopenReminderAction(snap) : null),
            }).then(() => undefined)
          )
        }
      >
        <Check className="h-3.5 w-3.5" />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={pending}
        aria-label="Snooze for a week"
        title="Snooze for a week"
        onClick={() =>
          start(() =>
            runToastAction({
              run: () => snoozeReminderAction(id, 7),
              success: "Snoozed for a week",
              failure: "Couldn’t snooze that — try again?",
              refresh: () => router.refresh(),
              undo: (snap) => (snap ? () => unsnoozeReminderAction(snap) : null),
            }).then(() => undefined)
          )
        }
      >
        <Clock className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
