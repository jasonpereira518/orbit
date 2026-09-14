import Link from "next/link";
import { Check } from "lucide-react";
import type { OutreachSetupStep } from "@/lib/outreach/types";
import { cn } from "@/lib/utils";

/** Review and Send have no route until stage 2, so they render as upcoming, never as links. */
const STEPS: Array<{ key: OutreachSetupStep; label: string; path: string | null }> = [
  { key: "describe", label: "Describe", path: null },
  { key: "audience", label: "Audience", path: "audience" },
  { key: "people", label: "People", path: "people" },
  { key: "review", label: "Review", path: null },
  { key: "send", label: "Send", path: null },
];
const ORDER = STEPS.map((s) => s.key);

export function SetupSteps({
  campaignId,
  current,
  reached,
}: {
  campaignId: string | null;
  current: OutreachSetupStep;
  reached: OutreachSetupStep;
}) {
  const currentIndex = ORDER.indexOf(current);
  const reachedIndex = ORDER.indexOf(reached === "tracking" ? "send" : reached);
  return (
    <nav aria-label="Campaign setup">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        {STEPS.map((step, index) => {
          const isCurrent = index === currentIndex;
          const done = index < currentIndex;
          const reachable = Boolean(campaignId && step.path && index <= Math.max(reachedIndex, currentIndex));
          const content = (
            <>
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full border text-[11px] tabular-nums",
                  isCurrent && "border-primary bg-primary text-primary-foreground",
                  done && "border-primary/40 text-primary",
                  !isCurrent && !done && "border-border text-muted-foreground"
                )}
              >
                {done ? <Check className="size-3" aria-hidden /> : index + 1}
              </span>
              <span className={isCurrent ? "text-ink" : "text-muted-foreground"}>{step.label}</span>
            </>
          );
          return (
            <li key={step.key} className="flex items-center gap-2">
              {reachable && !isCurrent ? (
                <Link
                  href={`/outreach/${campaignId}/${step.path}`}
                  className="flex items-center gap-2 rounded-md px-1 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {content}
                </Link>
              ) : (
                <span aria-current={isCurrent ? "step" : undefined} className="flex items-center gap-2 px-1">
                  {content}
                </span>
              )}
              {index < STEPS.length - 1 && <span aria-hidden className="h-px w-5 bg-border" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
