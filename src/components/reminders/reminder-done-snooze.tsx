"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Check, Clock } from "lucide-react";
import { toast } from "@/lib/toast";
import { markReminderDone, snoozeReminderAction } from "@/actions/reminders";
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
    </div>
  );
}
