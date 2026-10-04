"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Gift, Infinity as InfinityIcon, MoreHorizontal } from "lucide-react";
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
import { setCompAction } from "@/actions/admin";
import { toast } from "@/lib/toast";
import { LifetimeDialog } from "@/components/admin/lifetime-dialog";
import { PlanBadge } from "@/components/admin/primitives";
import { FREE_CONTACT_LIMIT, PLAN_CONFIG, PLAN_LABELS, type Plan } from "@/lib/plans/plan-config";
import type { PlanSource } from "@/lib/entitlements";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";

type Choice = "orbit" | "max" | "lifetime" | "none";

/**
 * How a choice's warning reads, and what colour it wears:
 * - `cost`: it costs Orbit real money every month (amber).
 * - `permanent`: it costs money with no end date, or is hard to walk back (red).
 * - `caution`: it can strand the account, but only in some states (amber).
 */
type Tone = "cost" | "permanent" | "caution";

type ChoiceCopy = {
  value: Choice;
  title: string;
  /** Scopes the plan accent (`data-plan`) so the row wears that tier's colour. */
  scope: Plan;
  tag?: { label: string; tone: Tone };
  lines: string[];
};

const hours = (seconds: number) => `${seconds / 3_600} hours`;
/** Orbit's own cost of a plan's included AI, at one cent a credit — the figure the old copy quoted. */
const aiCost = (credits: number) => `about $${credits / 100}`;

/**
 * Every number here is read from PLAN_CONFIG, the table the gates themselves read, so this
 * dialog cannot promise something the plan no longer grants. A comp is Pro, Max or Lifetime
 * (pricing v2); all three cost Orbit real money — included AI on Orbit's keys, transcription
 * hours and Apollo enrichments — so each row says how much, up front. Lifetime is confirmed
 * in `LifetimeDialog`, which previews what happens to a live subscription first.
 */
function choicesFor(currentPlan: Plan, contactCount: number): ChoiceCopy[] {
  const { orbit, max, lifetime } = PLAN_CONFIG;
  const overCap = contactCount > FREE_CONTACT_LIMIT;

  return [
    {
      value: "orbit",
      title: PLAN_LABELS.orbit,
      scope: "orbit",
      tag: { label: `costs you ${aiCost(orbit.monthlyCredits ?? 0).replace("about ", "~")}/mo`, tone: "cost" },
      lines: [
        `Up to ${orbit.monthlyCredits} AI credits a month on Orbit's keys (${aiCost(orbit.monthlyCredits ?? 0)}).`,
        `${hours(orbit.speech.meetingSeconds)} of meeting transcription and ${orbit.hostedEnrichmentsPerMonth} Apollo enrichments a month on Orbit's accounts.`,
        "Unlimited contacts. No REST API.",
      ],
    },
    {
      value: "max",
      title: PLAN_LABELS.max,
      scope: "max",
      tag: { label: `costs you ${aiCost(max.monthlyCredits ?? 0).replace("about ", "~")}/mo`, tone: "cost" },
      lines: [
        `Up to ${max.monthlyCredits} AI credits a month on Orbit's keys (${aiCost(max.monthlyCredits ?? 0)}).`,
        `${hours(max.speech.meetingSeconds)} of transcription, ${max.hostedEnrichmentsPerMonth} enrichments a month, and the REST API.`,
      ],
    },
    {
      value: "lifetime",
      title: PLAN_LABELS.lifetime,
      scope: "lifetime",
      tag: { label: "permanent, no expiry", tone: "permanent" },
      lines: [
        `Every Max feature for good, but AI runs only on their own key: no credits, no packs.`,
        `Still ${hours(lifetime.speech.meetingSeconds)} of transcription and ${lifetime.hostedEnrichmentsPerMonth} enrichments a month on Orbit's accounts.`,
        "A live subscription is set to end at its period end — no refund. You review that before anything changes.",
      ],
    },
    {
      value: "none",
      title: currentPlan === "lifetime" ? "Remove Lifetime" : "Remove comp",
      scope: "free",
      tag: overCap
        ? { label: `over the ${FREE_CONTACT_LIMIT}-contact cap`, tone: "caution" }
        : undefined,
      lines: [
        currentPlan === "lifetime"
          ? "You review what happens to the account before anything changes."
          : "Falls back to their real billing state.",
        overCap
          ? `They have ${contactCount} contacts. If they fall back to Free they keep them but cannot add more.`
          : `If they land on Free they keep everything and can add up to ${FREE_CONTACT_LIMIT} contacts.`,
      ],
    },
  ];
}

const TAG_TONE: Record<Tone, string> = {
  cost: "bg-warning/15 text-warning",
  permanent: "bg-destructive/10 text-destructive",
  caution: "bg-warning/15 text-warning",
};

/** Used when the operator does not type one. Recorded verbatim, so it says what it is. */
const DEFAULT_REASON = "Set from the admin console";

export function CompPlanButton(props: {
  targetUserId: string;
  email: string | null;
  currentPlan: Plan;
  currentSource: PlanSource;
  contactCount: number;
  compedNote: string | null;
  /**
   * `badge` turns the plan cell itself into the trigger, which is the roster's one-click
   * path: the plan is the thing being looked at, so it is also the thing to click. `menu`
   * and `button` remain for the `⋯` overflow and the account page header.
   */
  variant: "menu" | "button" | "badge";
}) {
  const [open, setOpen] = useState(false);
  // Lifetime is confirmed in its own dialog (it previews the Stripe side first), so the comp
  // dialog hands off to it and steps out of the way.
  const [lifetime, setLifetime] = useState<"grant" | "revoke" | null>(null);

  return (
    <>
      {props.variant === "badge" ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Change plan for ${props.email ?? props.targetUserId}`}
          className="rounded-md transition-opacity duration-fast hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <PlanBadge
            plan={props.currentPlan}
            source={props.currentSource}
            title={
              props.compedNote
                ? `Comped — ${props.compedNote}. Click to change.`
                : "Click to change this plan"
            }
          />
        </button>
      ) : props.variant === "menu" ? (
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

      <CompPlanDialog
        {...props}
        open={open}
        onOpenChange={setOpen}
        onLifetime={(mode) => {
          setOpen(false);
          setLifetime(mode);
        }}
      />
      {lifetime && (
        <LifetimeDialog
          targetUserId={props.targetUserId}
          mode={lifetime}
          onClose={() => setLifetime(null)}
        />
      )}
    </>
  );
}

function CompPlanDialog({
  targetUserId,
  email,
  currentPlan,
  currentSource,
  contactCount,
  open,
  onOpenChange,
  onLifetime,
}: {
  targetUserId: string;
  email: string | null;
  currentPlan: Plan;
  currentSource: PlanSource;
  contactCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLifetime: (mode: "grant" | "revoke") => void;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState<Choice>(
    currentSource === "comp" || currentPlan === "lifetime" ? "none" : "orbit"
  );
  const [pending, startTransition] = useTransition();
  const choices = choicesFor(currentPlan, contactCount);

  const submit = () => {
    // Lifetime, and taking it away, both go through the dialog that previews the effect.
    if (choice === "lifetime") return onLifetime("grant");
    if (choice === "none" && currentPlan === "lifetime") return onLifetime("revoke");

    startTransition(async () => {
      try {
        // No "why" field: the operator is not asked to type one. `setCompAction` still
        // needs a reason for the audit row and `comped_note`, so the default says what it is.
        const result = await setCompAction({
          targetUserId,
          plan: choice === "none" ? null : choice,
          reason: DEFAULT_REASON,
        });
        toast.success(
          choice === "none"
            ? `Comp removed — now on ${PLAN_LABELS[result.plan]}`
            : `Comped ${PLAN_LABELS[result.plan]}`
        );
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error(
          friendlyError(err, "Couldn’t change the plan — try again?")
        );
      }
    });
  };

  const selected = choices.find((c) => c.value === choice)!;

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
          {choices.map((option) => (
            <label
              key={option.value}
              // `data-plan` hands the row its tier's accent, so Pro reads blue, Max gold and
              // Lifetime slate — the same colours as the plan badge in the roster.
              data-plan={option.scope}
              className={cn(
                "flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors duration-fast",
                choice === option.value
                  ? option.value === "none"
                    ? "border-border bg-muted/50"
                    : "border-tier-border bg-tier-surface"
                  : "border-border/70 hover:border-border"
              )}
            >
              <input
                type="radio"
                name="comp-plan"
                value={option.value}
                checked={choice === option.value}
                onChange={() => setChoice(option.value)}
                className="mt-1 size-3.5 accent-[var(--tier-accent)]"
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      "text-sm font-medium",
                      option.value !== "none" && "text-tier-accent"
                    )}
                  >
                    {option.title}
                  </span>
                  {option.tag && (
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.6875rem]",
                        TAG_TONE[option.tag.tone]
                      )}
                    >
                      {option.tag.tone === "permanent" ? (
                        <InfinityIcon className="size-3" aria-hidden />
                      ) : (
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

        <p className="text-xs text-muted-foreground">
          {choice === "lifetime" || (choice === "none" && currentPlan === "lifetime")
            ? "Next you review what happens to the account and its subscription. Nothing changes until you confirm there."
            : "Takes effect immediately. A comp overrides all real billing state, with no expiry."}
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
                ? selected.title
                : choice === "lifetime"
                  ? "Review Lifetime grant"
                  : `Comp ${selected.title}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
