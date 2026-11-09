"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { confirmCheckoutSession, startPlanSwitch } from "@/actions/billing";
import { dismissMaxNudge, getCreditsOverview, setCreditEmailEnabled, type CreditsOverview } from "@/actions/credits";
import { BuyPackButton } from "@/components/credits/buy-pack-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Disclosure } from "@/components/settings/disclosure";
import { cn } from "@/lib/utils";
import { formatAllowanceReset, allowancePercentUsed, FREE_LOW_CREDITS } from "@/lib/ai-access-copy";
import { useViewerPlan } from "@/components/viewer-plan";
import { CREDIT_PACK_CREDITS, CREDIT_PACK_PRICE_LABEL } from "@/lib/stripe-config";
import { toast } from "@/lib/toast";

const MICROS_PER_CREDIT = 10_000;
const credits = (micros: number) => Math.floor(Math.max(0, micros) / MICROS_PER_CREDIT);
const fmt = (n: number) => n.toLocaleString("en-US");

const ACTION_LABEL = {
  capture: ["capture", "captures"],
  chat: ["chat answer", "chat answers"],
  summary: ["meeting summary", "meeting summaries"],
} as const;

function equivalentsLine(items: CreditsOverview["equivalents"]): string | null {
  if (items.length === 0) return null;
  const parts = items.map(({ action, count }) => `${fmt(count)} ${ACTION_LABEL[action][count === 1 ? 0 : 1]}`);
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
  return `Roughly ${list} at this month’s prices`;
}

/**
 * The credits, read once for the Plan and usage card. The hook owns the load, the
 * pack-checkout confirm on the way back from Stripe, and the one-time Max nudge. Nothing here
 * — or anywhere — charges automatically.
 */
function useCreditsOverview() {
  const [overview, setOverview] = useState<CreditsOverview | null | undefined>(undefined);
  const [nudgeOpen, setNudgeOpen] = useState(false);
  const params = useSearchParams();
  const router = useRouter();

  const load = useCallback(async () => {
    const next = await getCreditsOverview().catch(() => null);
    setOverview(next);
    if (next?.showMaxNudge) {
      // One-time: recorded as seen the moment it is shown, whatever the person picks.
      setNudgeOpen(true);
      void dismissMaxNudge();
    }
  }, []);

  useEffect(() => {
    let live = true;
    // Back from a pack checkout: confirm with Stripe directly, so the credits show now rather
    // than whenever the webhook lands. The grant is idempotent either way.
    const sessionId = params.get("session_id");
    const confirm =
      params.get("credits") === "added" && sessionId ? confirmCheckoutSession(sessionId).catch(() => null) : null;
    (async () => {
      const result = confirm ? await confirm : null;
      if (!live) return;
      if (result?.status === "granted") toast.success(`${CREDIT_PACK_CREDITS} credits added`);
      else if (result?.status === "processing") toast.info("Your payment is still clearing — the credits arrive the moment it does");
      await load();
      if (confirm) router.replace("/settings#settings-plan", { scroll: false });
    })();
    return () => {
      live = false;
    };
    // Once per visit: the search params are read on arrival only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { overview, nudge: <MaxNudgeDialog open={nudgeOpen} onOpenChange={setNudgeOpen} /> };
}

function facts(overview: CreditsOverview, planConfig: ReturnType<typeof useViewerPlan>["planConfig"]) {
  const { balance, monthlyCredits, plan } = overview;
  const allowance = balance.allowance;
  return {
    plan,
    monthlyCredits,
    allowance,
    packsSold: planConfig[plan].features.creditPacks,
    spendableLeft: credits(balance.spendable),
    starterLeft: credits(balance.starterRemaining),
    packLeft: credits(balance.packRemaining),
    packsFrozen: balance.packsFrozen,
    used: allowance ? allowancePercentUsed(allowance) : 100,
    out: monthlyCredits > 0 && balance.spendable <= 0,
    resets: allowance ? formatAllowanceReset(allowance.periodEnd) : plan === "free" ? "the 1st" : "your plan renews",
  };
}

/**
 * The AI credits meter on the Plan and usage card: credits left, the month's bar in the plan's
 * colour, a notice when something needs doing, the one action that adds more, and the detail
 * folded away. Renders nothing when the overview can't be read — the card's other meters
 * don't depend on it.
 */
export function CreditsUsage({ meterClassName }: { meterClassName: string }) {
  const { planConfig } = useViewerPlan();
  const { overview, nudge } = useCreditsOverview();
  if (overview === null) return null;
  const f = overview ? facts(overview, planConfig) : null;
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-muted-foreground">AI credits</span>
        <span className="tabular-nums" title={f?.allowance ? `Monthly credits reset ${f.resets}` : undefined}>
          {f ? `${fmt(f.spendableLeft)} left this month` : "…"}
        </span>
      </div>
      {f?.allowance ? (
        <div
          className="h-1.5 overflow-hidden rounded-full bg-muted"
          role="meter"
          aria-label="Monthly AI credits used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={f.used}
        >
          <div className={cn("h-full rounded-full transition-[width]", meterClassName)} style={{ width: `${f.used}%` }} />
        </div>
      ) : null}
      {overview ? <CreditsNotice overview={overview} /> : null}
      {f && f.plan !== "free" && f.monthlyCredits > 0 && f.packsSold && !f.out ? (
        <BuyPackButton variant="outline" label="Add credits" />
      ) : null}
      {overview ? (
        <Disclosure label="Credit details" className="border-t-0 pt-0">
          <CreditsDetails overview={overview} />
        </Disclosure>
      ) : null}
      {nudge}
    </div>
  );
}

/** Only when something needs doing: out of credits, or a Free account nearly out. */
function CreditsNotice({ overview }: { overview: CreditsOverview | null | undefined }) {
  const { planConfig } = useViewerPlan();
  if (!overview) return null;
  const f = facts(overview, planConfig);
  if (f.out) {
    return (
      <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-warning-border bg-warning-surface p-3 text-sm text-foreground">
        <p className="min-w-0 flex-1">
          {f.packsSold
            ? `Out of credits — AI is paused until ${f.resets}`
            : `Out of credits until ${f.resets} · add your own key for no limit`}
        </p>
        {f.packsSold ? (
          <div className="flex flex-wrap gap-2">
            <BuyPackButton />
            {f.plan === "orbit" && <UpgradeToMaxButton />}
          </div>
        ) : null}
      </div>
    );
  }
  if (f.plan === "free" && f.spendableLeft <= FREE_LOW_CREDITS) {
    return (
      <p role="status" className="rounded-xl bg-muted/50 p-3 text-sm text-foreground">
        {f.spendableLeft} AI {f.spendableLeft === 1 ? "credit" : "credits"} left this month
      </p>
    );
  }
  return null;
}

/** The rest, folded away: where the credits come from, what they buy, and the emails. */
function CreditsDetails({ overview }: { overview: CreditsOverview }) {
  const { planConfig } = useViewerPlan();
  const f = facts(overview, planConfig);
  const line = equivalentsLine(overview.equivalents);
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      {f.monthlyCredits > 0 && f.allowance ? (
        <p>
          {fmt(credits(f.allowance.remaining))} of {fmt(f.monthlyCredits)} monthly · resets {f.resets}
        </p>
      ) : null}
      {f.starterLeft > 0 ? <p>{fmt(f.starterLeft)} starter credits · used after monthly</p> : null}
      {(f.packsSold || f.packsFrozen) && (f.packLeft > 0 || f.monthlyCredits > 0) ? (
        <p>
          {f.packsFrozen
            ? `${fmt(f.packLeft)} pack credits kept · back when your plan can use them`
            : f.packLeft > 0
              ? `${fmt(f.packLeft)} pack credits · roll over monthly`
              : `No pack credits · ${CREDIT_PACK_CREDITS} for ${CREDIT_PACK_PRICE_LABEL}`}
        </p>
      ) : null}
      {line ? <p>{line}</p> : null}
      {f.monthlyCredits > 0 && f.packsSold && f.plan === "orbit" && !f.out ? <UpgradeToMaxButton /> : null}
      {f.monthlyCredits > 0 && f.packsSold ? <CreditEmailToggle initial={overview.creditEmailEnabled} /> : null}
    </div>
  );
}

/**
 * The emails at 80% and 100% of the monthly credits. Saved as soon as it changes; a failed
 * save puts the box back, so it never shows a choice that was not kept.
 */
function CreditEmailToggle({ initial }: { initial: boolean }) {
  const [enabled, setEnabled] = useState(initial);
  const [pending, start] = useTransition();
  return (
    <label className="flex items-start gap-2 pt-1 text-sm text-muted-foreground">
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-tier-accent"
        checked={enabled}
        disabled={pending}
        onChange={(event) => {
          const next = event.target.checked;
          setEnabled(next);
          start(async () => {
            const result = await setCreditEmailEnabled(next).catch(() => ({ ok: false }));
            if (!result.ok) {
              setEnabled(!next);
              toast.error("Couldn’t save that — try again?");
            }
          });
        }}
      />
      <span>Email me at 80% and when they run out</span>
    </label>
  );
}

function UpgradeToMaxButton({ label = "Upgrade to Max" }: { label?: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      data-plan="max"
      className="text-tier-accent hover:bg-tier-accent/10"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const result = await startPlanSwitch("max");
          if ("url" in result) {
            window.location.href = result.url;
            return;
          }
          toast.error(result.error);
        })
      }
    >
      {pending && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
      {label}
    </Button>
  );
}

/**
 * Shown once, ever: the second pack a Pro account buys in one billing cycle. States the
 * arithmetic and leaves the choice with the person.
 */
function MaxNudgeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { planConfig } = useViewerPlan();
  const close = (next: boolean) => onOpenChange(next);
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Worth a look: Orbit Max</DialogTitle>
          <DialogDescription>
            Two packs plus Pro is about the price of Max, which includes {planConfig.max.monthlyCredits} credits a month plus more transcription
            {planConfig.max.features.api && !planConfig.orbit.features.api ? " and the REST API" : ""}.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" size="sm" onClick={() => close(false)}>
            Not now
          </Button>
          <UpgradeToMaxButton label="See Max" />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
