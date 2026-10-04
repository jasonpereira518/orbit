"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Check, Gift, Infinity as InfinityIcon, MoreHorizontal, Undo2 } from "lucide-react";
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

type ChoiceCopy = {
  value: Choice;
  title: string;
  /** The plan this card is dressed as; also scopes `data-plan` for its accent colours. */
  scope: Plan;
  /** One line of voice, set under the name. */
  tagline: string;
  /** What it costs you, in the sentence rather than in a warning badge. */
  description: ReactNode;
  /** Short allowance chips along the bottom. */
  chips: string[];
};

const hours = (seconds: number) => `${seconds / 3_600} h`;
const hoursLong = (seconds: number) => `${seconds / 3_600} hours`;
/** Orbit's own cost of a plan's included AI, at one cent a credit — the figure the old copy quoted. */
const aiDollars = (credits: number) => `$${credits / 100}`;

/**
 * Every number is read from PLAN_CONFIG, the table the gates themselves read, so a card
 * cannot promise something the plan no longer grants. All three comps cost Orbit real money,
 * and the amount is part of each description. Lifetime is confirmed in `LifetimeDialog`,
 * which previews what happens to a live subscription first.
 */
function choicesFor(currentPlan: Plan, contactCount: number): ChoiceCopy[] {
  const { orbit, max, lifetime } = PLAN_CONFIG;
  const overCap = contactCount > FREE_CONTACT_LIMIT;

  return [
    {
      value: "orbit",
      title: PLAN_LABELS.orbit,
      scope: "orbit",
      tagline: "Everything switched on.",
      description: (
        <>
          Costs you about <strong>{aiDollars(orbit.monthlyCredits ?? 0)} a month</strong> in AI
          ({orbit.monthlyCredits} credits on Orbit&rsquo;s keys), plus{" "}
          {hoursLong(orbit.speech.meetingSeconds)} of meeting transcription and{" "}
          {orbit.hostedEnrichmentsPerMonth} Apollo enrichments on Orbit&rsquo;s accounts.
        </>
      ),
      chips: ["Unlimited contacts", `${orbit.monthlyCredits} credits`, "No REST API"],
    },
    {
      value: "max",
      title: PLAN_LABELS.max,
      scope: "max",
      tagline: "The full instrument.",
      description: (
        <>
          Costs you about <strong>{aiDollars(max.monthlyCredits ?? 0)} a month</strong> in AI
          ({max.monthlyCredits} credits on Orbit&rsquo;s keys), plus{" "}
          {hoursLong(max.speech.meetingSeconds)} of transcription and{" "}
          {max.hostedEnrichmentsPerMonth} enrichments a month on Orbit&rsquo;s accounts.
        </>
      ),
      chips: [`${max.monthlyCredits} credits`, `${hours(max.speech.meetingSeconds)} audio`, "REST API"],
    },
    {
      value: "lifetime",
      title: PLAN_LABELS.lifetime,
      scope: "lifetime",
      tagline: "Yours for good.",
      description: (
        <>
          Costs you <strong>$0 in AI</strong>, since it runs on their own key. But{" "}
          {hoursLong(lifetime.speech.meetingSeconds)} of transcription and{" "}
          {lifetime.hostedEnrichmentsPerMonth} enrichments a month stay on Orbit&rsquo;s accounts
          with no end date. A live subscription is set to end at its period end, with no refund.
        </>
      ),
      chips: ["Every Max feature", "No expiry", "Own AI key"],
    },
    {
      value: "none",
      title: currentPlan === "lifetime" ? "Remove Lifetime" : "Remove comp",
      scope: "free",
      tagline: "Back to real billing.",
      description:
        currentPlan === "lifetime" ? (
          "You review what happens to the account before anything changes."
        ) : overCap ? (
          <>
            Falls back to their real billing state. They have <strong>{contactCount} contacts</strong>,
            over the {FREE_CONTACT_LIMIT} cap: on Free they keep them but cannot add more.
          </>
        ) : (
          `Falls back to their real billing state. On Free they keep everything and can add up to ${FREE_CONTACT_LIMIT} contacts.`
        ),
      chips: [],
    },
  ];
}

/**
 * One card per plan, each dressed as that plan rather than as a variation of a list row:
 * Pro is a blue orbit diagram, Max a struck gold plate, Lifetime a dark platinum card with
 * an infinity watermark, and Remove a quiet dashed outline. `data-plan` supplies the colours;
 * the artwork is inline SVG so nothing is fetched and it follows the tier tokens.
 */
function PlanArt({ plan }: { plan: Choice }) {
  const common = { "aria-hidden": true, className: "pointer-events-none absolute inset-0 size-full" } as const;
  if (plan === "orbit")
    return (
      <svg viewBox="0 0 200 120" preserveAspectRatio="xMaxYMin slice" {...common}>
        <g fill="none" stroke="var(--tier-accent)" strokeOpacity="0.28">
          <ellipse cx="170" cy="14" rx="80" ry="30" transform="rotate(-18 170 14)" />
          <ellipse cx="170" cy="14" rx="56" ry="20" transform="rotate(-18 170 14)" />
          <ellipse cx="170" cy="14" rx="32" ry="11" transform="rotate(-18 170 14)" />
        </g>
        <circle cx="118" cy="30" r="3.2" fill="var(--tier-accent)" fillOpacity="0.7" />
        <circle cx="170" cy="14" r="5" fill="var(--tier-accent)" fillOpacity="0.35" />
      </svg>
    );
  if (plan === "max")
    return (
      <svg viewBox="0 0 200 120" preserveAspectRatio="xMidYMid slice" {...common}>
        <defs>
          <linearGradient id="max-glint" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.5" stopColor="#fff" stopOpacity="0.5" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g stroke="#3d2c00" strokeOpacity="0.14" fill="none">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <line key={i} x1={20 + i * 34} y1="-4" x2={-40 + i * 34} y2="124" />
          ))}
        </g>
        <rect x="-30" y="0" width="50" height="120" fill="url(#max-glint)" transform="translate(110 0) skewX(-20)" />
      </svg>
    );
  if (plan === "lifetime")
    return (
      <>
        <svg viewBox="0 0 200 120" preserveAspectRatio="xMidYMid slice" {...common}>
          <g fill="#fff">
            <circle cx="22" cy="18" r="0.9" fillOpacity="0.7" />
            <circle cx="64" cy="100" r="0.7" fillOpacity="0.5" />
            <circle cx="150" cy="22" r="1" fillOpacity="0.6" />
            <circle cx="182" cy="92" r="0.8" fillOpacity="0.5" />
            <circle cx="104" cy="12" r="0.6" fillOpacity="0.4" />
          </g>
        </svg>
        <InfinityIcon
          aria-hidden
          strokeWidth={1.25}
          className="pointer-events-none absolute -right-3 -top-3 size-24 text-white/10"
        />
      </>
    );
  return null;
}

/** Surface, ink and selection ring per card. Pro/Max/Lifetime are fixed looks; Remove is neutral. */
const CARD_LOOK: Record<Choice, { card: string; ink: string; sub: string; chip: string; check: string }> = {
  orbit: {
    card: "border-tier-border bg-gradient-to-br from-tier-surface via-transparent to-transparent",
    ink: "text-tier-accent",
    sub: "text-muted-foreground",
    chip: "border border-tier-border text-tier-accent",
    check: "bg-tier-accent text-background",
  },
  max: {
    card: "border-transparent bg-gradient-to-br from-tier-sheen-from to-tier-sheen-to shadow-sm",
    ink: "text-tier-sheen-ink",
    sub: "text-tier-sheen-ink/80",
    chip: "bg-tier-sheen-ink/10 text-tier-sheen-ink",
    check: "bg-tier-sheen-ink text-tier-sheen-from",
  },
  lifetime: {
    card: "border-transparent bg-gradient-to-br from-[#2b323c] to-[#46505d] shadow-sm",
    ink: "text-white",
    sub: "text-white/75",
    chip: "bg-white/10 text-white/90",
    check: "bg-white text-[#242b34]",
  },
  none: {
    card: "border-dashed border-border bg-transparent",
    ink: "text-foreground",
    sub: "text-muted-foreground",
    chip: "",
    check: "bg-foreground text-background",
  },
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
      <DialogContent className="sm:max-w-2xl">
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

        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="sr-only">Which plan to comp</legend>
          {choices.map((option) => {
            const look = CARD_LOOK[option.value];
            const isSelected = choice === option.value;
            return (
              <label
                key={option.value}
                data-plan={option.scope}
                className={cn(
                  "group relative flex min-h-44 cursor-pointer flex-col overflow-hidden rounded-2xl border p-4",
                  "transition-[transform,box-shadow] duration-fast hover:-translate-y-0.5",
                  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                  look.card,
                  isSelected
                    ? "ring-2 ring-tier-accent ring-offset-2 ring-offset-background"
                    : option.value === "none"
                      ? "hover:border-foreground/40"
                      : "opacity-90 hover:opacity-100"
                )}
              >
                <input
                  type="radio"
                  name="comp-plan"
                  value={option.value}
                  checked={isSelected}
                  onChange={() => setChoice(option.value)}
                  className="sr-only"
                />
                <PlanArt plan={option.value} />
                <span
                  aria-hidden
                  className={cn(
                    "absolute right-3 top-3 grid size-5 place-items-center rounded-full transition-[opacity,transform] duration-fast",
                    look.check,
                    isSelected ? "scale-100 opacity-100" : "scale-75 opacity-0"
                  )}
                >
                  <Check className="size-3" strokeWidth={3} />
                </span>

                <span className="relative flex flex-1 flex-col">
                  <span
                    className={cn("flex items-center gap-1.5 font-heading text-lg leading-tight", look.ink)}
                  >
                    {option.value === "none" && <Undo2 className="size-4" aria-hidden />}
                    {option.title}
                  </span>
                  <span className={cn("text-xs italic", look.sub)}>{option.tagline}</span>
                  <span className={cn("mt-2 block text-xs leading-relaxed", look.sub, "[&_strong]:font-semibold", option.value === "max" ? "[&_strong]:text-tier-sheen-ink" : option.value === "lifetime" ? "[&_strong]:text-white" : "[&_strong]:text-foreground")}>
                    {option.description}
                  </span>
                  {option.chips.length > 0 && (
                    <span className="mt-auto flex flex-wrap gap-1 pt-3">
                      {option.chips.map((chip) => (
                        <span
                          key={chip}
                          className={cn("rounded-full px-2 py-0.5 text-[0.6875rem]", look.chip)}
                        >
                          {chip}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
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
