"use client";

import { useCallback, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, ListChecks, X } from "lucide-react";
import { removeOnboardingExamples } from "@/actions/onboarding-examples";
import { restartTour, resumeTour } from "@/actions/tour";
import { ProTag } from "@/components/onboarding/onboarding-ui";
import { Button, buttonVariants } from "@/components/ui/button";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

export type SetupChecklistItem = {
  id: string;
  label: string;
  detail: string;
  /** A page to go to, or an action the card runs itself. */
  href?: string;
  action?: "resume-tour" | "start-tour" | "remove-examples";
  tag?: "pro";
};

const DISMISS_KEY = "orbit-setup-checklist-dismissed-v1";
const listeners = new Set<() => void>();

function readDismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * "Finish setting up": whatever onboarding left open, with live status, until it is all done
 * or dismissed on this device. The server section decides the items; this only renders them
 * and runs the three actions that are not links.
 *
 * The server snapshot is "dismissed", so nothing renders into the HTML and a dismissed card
 * never flashes before hydration reads localStorage.
 */
export function SetupChecklistCard({ items }: { items: SetupChecklistItem[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const dismissed = useSyncExternalStore(subscribe, readDismissed, () => true);
  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Private mode or a full quota: the card just comes back next visit.
    }
    listeners.forEach((l) => l());
  }, []);

  if (dismissed || items.length === 0) return null;

  const run = (action: NonNullable<SetupChecklistItem["action"]>) =>
    start(async () => {
      try {
        if (action === "remove-examples") {
          const res = await removeOnboardingExamples();
          toast.success(res.removed > 0 ? "Example people removed" : "No example people left to remove");
          router.refresh();
          return;
        }
        const res = action === "resume-tour" ? await resumeTour() : await restartTour();
        router.push(res.redirectTo);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t do that — try again?"));
      }
    });

  return (
    <section
      aria-label="Finish setting up"
      className="reveal-mount rounded-2xl border border-border/70 bg-card px-4 py-3"
    >
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-primary">
          <ListChecks className="size-4" aria-hidden />
        </span>
        <p className="min-w-0 flex-1 text-sm">
          <span className="font-medium text-ink">Finish setting up</span>{" "}
          <span className="text-muted-foreground">
            {items.length === 1 ? "One thing left from onboarding." : `${items.length} things left from onboarding.`}
          </span>
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          onClick={dismiss}
          aria-label="Dismiss the setup checklist"
        >
          <X aria-hidden />
        </Button>
      </div>
      <ul className="mt-3 divide-y divide-border/60">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5 font-medium text-ink">
                {item.label}
                {item.tag === "pro" && <ProTag />}
              </span>
              <span className="block text-muted-foreground">{item.detail}</span>
            </span>
            {item.href ? (
              <Link href={item.href} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                Open
                <ArrowRight aria-hidden />
              </Link>
            ) : item.action ? (
              <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => run(item.action!)}>
                {item.action === "remove-examples" ? "Remove" : item.action === "resume-tour" ? "Resume" : "Start"}
                <ArrowRight aria-hidden />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
