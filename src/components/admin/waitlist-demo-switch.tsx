"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { MonitorPlay, MonitorOff } from "lucide-react";
import { setWaitlistDemoAction } from "@/actions/admin";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * The switch for the waitlist page's "Take it for a spin" demo. No confirm dialog: it is
 * cosmetic and reversible, and the admin audit log still records who flipped it.
 */
export function WaitlistDemoSwitch({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function flip() {
    startTransition(async () => {
      try {
        const res = await setWaitlistDemoAction({ enabled: !enabled });
        toast.success(res.enabled ? "The demo is back on the waitlist page" : "The demo is hidden from the waitlist page");
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t change the demo — try again?"));
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm">
          {enabled ? (
            <MonitorPlay className="size-3.5 text-primary" aria-hidden />
          ) : (
            <MonitorOff className="size-3.5 text-muted-foreground" aria-hidden />
          )}
          {enabled ? "The demo is showing" : "The demo is hidden"}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {enabled
            ? "Visitors on desktop see “Take it for a spin”, the interactive preview above “How early access works”."
            : "The waitlist page skips “Take it for a spin” and goes straight from the three points to “How early access works”."}{" "}
          Changes reach every server within about ten seconds. Phones never see the demo either way.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Show the product demo on the waitlist page"
        disabled={pending}
        onClick={flip}
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-fast disabled:opacity-60",
          enabled ? "border-primary/40 bg-primary" : "border-border bg-muted"
        )}
      >
        <span
          aria-hidden
          className={cn(
            "inline-block size-4.5 rounded-full bg-background shadow transition-transform duration-fast",
            enabled ? "translate-x-[1.35rem]" : "translate-x-0.5"
          )}
        />
      </button>
    </div>
  );
}
