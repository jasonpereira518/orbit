"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Clock3 } from "lucide-react";
import {
  acknowledgeIssueAction,
  snoozeIssueAction,
} from "@/actions/admin";
import { toast } from "@/lib/toast";

export function IssueActions({ issueId }: { issueId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const run = (task: () => Promise<unknown>, message: string) => {
    startTransition(async () => {
      try {
        await task();
        toast.success(message);
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "The issue could not be updated.");
      }
    });
  };

  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => run(() => acknowledgeIssueAction({ issueId }), "Issue acknowledged.")}
        className="inline-flex h-7 items-center gap-1 rounded-md border border-border/70 px-2 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
      >
        <Check className="size-3" aria-hidden />
        Acknowledge
      </button>
      <details className="relative">
        <summary className="flex h-7 cursor-pointer list-none items-center gap-1 rounded-md border border-border/70 px-2 text-xs text-muted-foreground transition-colors hover:text-foreground">
          <Clock3 className="size-3" aria-hidden />
          Snooze
        </summary>
        <div className="absolute right-0 top-8 z-20 w-32 rounded-lg border border-border/70 bg-popover p-1 shadow-[0_12px_30px_-18px_rgba(26,28,26,0.5)]">
          {([
            [1, "1 hour"],
            [24, "1 day"],
            [168, "7 days"],
          ] as const).map(([hours, label]) => (
            <button
              key={hours}
              type="button"
              disabled={pending}
              onClick={() =>
                run(
                  () => snoozeIssueAction({ issueId, hours }),
                  `Issue snoozed for ${label}.`
                )
              }
              className="block w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-50"
            >
              {label}
            </button>
          ))}
        </div>
      </details>
    </div>
  );
}
