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
import { Skeleton } from "@/components/ui/skeleton";
import { formatAllowanceReset, allowancePercentUsed } from "@/lib/ai-access-copy";
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
  return `That’s roughly ${list}, at what they’ve actually cost across Orbit this month.`;
}

/**
 * The credits card on the AI settings page (Pro and Max; also shown to anyone holding
 * frozen pack credits). Allowance left this cycle, pack credits, the reset date, and what
 * that buys in plain language. Two actions, both explicit: buy a $5 pack, or (on Pro) move to
 * Max. Nothing here — or anywhere — charges automatically.
 */
export function CreditsCard() {
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
      if (result?.status === "granted") toast.success("250 credits added");
      else if (result?.status === "processing") toast.info("Your payment is still clearing — the credits arrive the moment it does");
      await load();
      if (confirm) router.replace("/settings?integration=ai", { scroll: false });
    })();
    return () => {
      live = false;
    };
    // Once per visit: the search params are read on arrival only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (overview === undefined) {
    return (
      <div className="space-y-2 rounded-xl border border-border/70 p-4" aria-busy="true" aria-label="Loading your credits">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-2 w-full" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
    );
  }
  if (overview === null) return null;

  const { balance, monthlyCredits, plan } = overview;
  const allowance = balance.allowance;
  const allowanceLeft = allowance ? credits(allowance.remaining) : 0;
  const packLeft = credits(balance.packRemaining);
  const used = allowance ? allowancePercentUsed(allowance) : 100;
  const out = monthlyCredits > 0 && balance.spendable <= 0;
  const line = equivalentsLine(overview.equivalents);

  return (
    <section
      aria-labelledby="credits-heading"
      className="space-y-3 rounded-xl border border-tier-border bg-tier-surface p-4"
      data-plan={plan}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="credits-heading" className="font-heading text-base text-ink">
          AI credits
        </h3>
      </div>

      {monthlyCredits > 0 && allowance && (
        <div className="space-y-1.5">
          <p className="text-sm text-ink">
            <strong className="font-medium">{fmt(allowanceLeft)}</strong> of {fmt(monthlyCredits)} monthly credits left
            <span className="text-muted-foreground"> · resets {formatAllowanceReset(allowance.periodEnd)}</span>
          </p>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="meter"
            aria-label="Monthly credits used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={used}
          >
            <div className="h-full rounded-full bg-tier-accent" style={{ width: `${used}%` }} />
          </div>
        </div>
      )}

      {(packLeft > 0 || monthlyCredits > 0) && (
        <p className="text-sm text-muted-foreground">
          {balance.packsFrozen ? (
            <>
              <strong className="font-medium text-ink">{fmt(packLeft)}</strong> pack credits kept for you. They come back the
              moment you’re on Pro or Max again.
            </>
          ) : packLeft > 0 ? (
            <>
              <strong className="font-medium text-ink">{fmt(packLeft)}</strong> pack credits — used after your monthly
              credits, and they roll over while you’re subscribed.
            </>
          ) : (
            "No pack credits. A pack adds 250 credits for $5, used after your monthly credits."
          )}
        </p>
      )}

      {out ? (
        <p role="status" className="rounded-lg border border-warning-border bg-warning-surface p-3 text-sm text-foreground">
          You’ve used your credits, so Orbit’s AI is paused until {allowance ? formatAllowanceReset(allowance.periodEnd) : "your plan renews"}.
          Nothing is charged automatically — add a pack to keep going{plan === "orbit" ? ", or move to Max for 500 credits a month" : ""}.
        </p>
      ) : (
        line && <p className="text-sm text-muted-foreground">{line}</p>
      )}

      {monthlyCredits > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <BuyPackButton variant={out ? "default" : "outline"} />
          {plan === "orbit" && <UpgradeToMaxButton />}
        </div>
      )}

      {monthlyCredits > 0 && <CreditEmailToggle initial={overview.creditEmailEnabled} />}

      <MaxNudgeDialog open={nudgeOpen} onOpenChange={setNudgeOpen} />
    </section>
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
    <label className="flex items-start gap-2 border-t border-tier-border pt-3 text-sm text-muted-foreground">
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
      <span>Email me when I’ve used 80% of my monthly credits, and when they run out.</span>
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
  const close = (next: boolean) => onOpenChange(next);
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Worth a look: Orbit Max</DialogTitle>
          <DialogDescription>
            Two packs plus Pro is about the price of Max, which includes 500 credits a month plus more transcription and
            enrichment.
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
