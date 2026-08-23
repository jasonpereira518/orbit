"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Gift, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { setCompAction } from "@/actions/admin";
import { toast } from "@/lib/toast";
import { PLAN_LABELS, type Plan } from "@/lib/plan-limits";
import type { PlanSource } from "@/lib/entitlements";
import { cn } from "@/lib/utils";

type Choice = "lifetime" | "orbit" | "none";

/**
 * The cost asymmetry here is the whole reason this is a dialog rather than a two-item menu,
 * because it runs exactly opposite to intuition:
 *
 *  - Comping LIFETIME is nearly free to Orbit. `entitlementsForPlan` gives it
 *    `canUseHostedEnrichment: false`, so it never touches Orbit's Apollo credits — the one
 *    metered cost with no ceiling. It does get `canUseHostedSending`, but every plan is
 *    capped at `DAILY_SEND_LIMIT` a day, so that exposure is bounded and knowable.
 *  - Comping ORBIT PRO costs real money. It sets `canUseHostedEnrichment: true`, unlocking
 *    Orbit's own Apollo credits, which nothing in the product rate-limits.
 *
 * "Lifetime sounds more generous" is exactly backwards, so the dialog says so out loud.
 */
const CHOICES: Array<{
  value: Choice;
  title: string;
  tag?: { label: string; tone: "good" | "warn" };
  lines: string[];
}> = [
  {
    value: "lifetime",
    title: "Orbit Lifetime",
    tag: { label: "recommended", tone: "good" },
    lines: [
      "Everything uncapped, permanently.",
      "Enrichment stays on their own Apollo key — the one uncapped cost.",
      "Sending is included, but capped per day like every plan.",
    ],
  },
  {
    value: "orbit",
    title: "Orbit Pro",
    tag: { label: "costs you money", tone: "warn" },
    lines: [
      "Everything in Lifetime, plus enrichment on Orbit's own Apollo credits.",
      "You pay for every prospect search and enrichment they run, with no daily ceiling.",
    ],
  },
  {
    value: "none",
    title: "Remove comp",
    lines: [
      "Falls back to their real billing state.",
      "If they are over the free contact cap, they keep existing contacts but cannot add more.",
    ],
  },
];

export function CompPlanButton(props: {
  targetUserId: string;
  email: string | null;
  currentPlan: Plan;
  currentSource: PlanSource;
  contactCount: number;
  compedNote: string | null;
  variant: "menu" | "button";
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {props.variant === "menu" ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Actions for ${props.email ?? props.targetUserId}`}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setOpen(true)}>
              <Gift className="size-3.5" aria-hidden />
              {props.currentSource === "comp" ? "Change comp…" : "Comp plan…"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Gift className="size-3.5" aria-hidden />
          {props.currentSource === "comp" ? "Change comp" : "Comp plan"}
        </Button>
      )}

      <CompPlanDialog {...props} open={open} onOpenChange={setOpen} />
    </>
  );
}

function CompPlanDialog({
  targetUserId,
  email,
  currentPlan,
  currentSource,
  contactCount,
  compedNote,
  open,
  onOpenChange,
}: {
  targetUserId: string;
  email: string | null;
  currentPlan: Plan;
  currentSource: PlanSource;
  contactCount: number;
  compedNote: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState<Choice>(
    currentSource === "comp" ? "none" : "lifetime"
  );
  const [reason, setReason] = useState(compedNote ?? "");
  const [pending, startTransition] = useTransition();

  const submit = () => {
    if (!reason.trim()) {
      toast.error("Add a reason — future-you will want to know why.");
      return;
    }

    startTransition(async () => {
      try {
        const result = await setCompAction({
          targetUserId,
          plan: choice === "none" ? null : choice,
          reason,
        });
        toast.success(
          choice === "none"
            ? `Comp removed — now on ${PLAN_LABELS[result.plan]}.`
            : `Comped ${PLAN_LABELS[result.plan]}.`
        );
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not change the plan."
        );
      }
    });
  };

  const selected = CHOICES.find((c) => c.value === choice)!;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Comp a plan</DialogTitle>
          <DialogDescription>
            {email ?? targetUserId} · currently{" "}
            <span className="text-foreground">{PLAN_LABELS[currentPlan]}</span>
            {currentSource === "comp" && " (comped)"} ·{" "}
            <span className="tabular-nums">{contactCount}</span> contact
            {contactCount === 1 ? "" : "s"}
          </DialogDescription>
        </DialogHeader>

        <fieldset className="space-y-2">
          <legend className="sr-only">Which plan to comp</legend>
          {CHOICES.map((option) => (
            <label
              key={option.value}
              className={cn(
                "flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors duration-fast",
                choice === option.value
                  ? "border-primary/50 bg-accent/8"
                  : "border-border/70 hover:border-border"
              )}
            >
              <input
                type="radio"
                name="comp-plan"
                value={option.value}
                checked={choice === option.value}
                onChange={() => setChoice(option.value)}
                className="mt-1 size-3.5 accent-[var(--primary)]"
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{option.title}</span>
                  {option.tag && (
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.6875rem]",
                        option.tag.tone === "warn"
                          ? "bg-destructive/10 text-destructive"
                          : "bg-accent/15 text-accent-foreground"
                      )}
                    >
                      {option.tag.tone === "warn" && (
                        <AlertTriangle className="size-3" aria-hidden />
                      )}
                      {option.tag.label}
                    </span>
                  )}
                </span>
                <span className="mt-1 block space-y-0.5 text-xs text-muted-foreground">
                  {option.lines.map((line) => (
                    <span key={line} className="block">
                      {line}
                    </span>
                  ))}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        <div>
          <label
            htmlFor="comp-reason"
            className="text-xs uppercase tracking-wide text-muted-foreground"
          >
            Why?
          </label>
          <Textarea
            id="comp-reason"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Beta feedback — found the import bug"
            className="mt-1 text-sm"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Only you ever see this. Stored on the account and in the audit trail.
          </p>
        </div>

        <p className="text-xs text-muted-foreground">
          Takes effect immediately. A comp overrides all real billing state, with no expiry.
        </p>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={pending}
            // Removing a comp can strand someone over the free cap, so it reads as
            // destructive rather than neutral.
            variant={choice === "none" ? "destructive" : "default"}
          >
            {pending
              ? "Saving…"
              : choice === "none"
                ? "Remove comp"
                : `Comp ${selected.title}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
