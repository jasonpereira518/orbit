"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Check, Clock } from "lucide-react";
import { toast } from "@/lib/toast";
import { markReminderDone, snoozeReminderAction } from "@/actions/reminders";
import { Button } from "@/components/ui/button";

export function ReminderActions({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <div className="flex gap-1">
      <Button
        size="icon"
        variant="ghost"
        disabled={pending}
        onClick={() =>
          start(async () => {
            await markReminderDone(id);
            toast.success("Marked done");
            router.refresh();
          })
        }
      >
        <Check className="h-4 w-4" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        disabled={pending}
        onClick={() =>
          start(async () => {
            await snoozeReminderAction(id, 7);
            toast.success("Snoozed 7 days");
            router.refresh();
          })
        }
      >
        <Clock className="h-4 w-4" />
      </Button>
    </div>
  );
}
