"use client";

import { useEffect, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  cancelSubscription,
  getSubscriptionOverview,
  resumeSubscription,
  startPlanSwitch,
  type SubscriptionOverview,
} from "@/actions/billing";
import { ManageBillingButton } from "@/components/settings/manage-billing-button";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { friendlyError } from "@/lib/errors";
import { FREE_CONTACT_LIMIT, PLAN_LABELS, type PurchasablePlan } from "@/lib/plans/plan-config";
import type { SubscriptionDetails } from "@/lib/subscription-management";

type Overview = Extract<SubscriptionOverview, { ok: true }>;
type Flow = null | "cancel";

const UNAVAILABLE = "Couldn’t reach billing just now — try again in a moment";

function money(cents: number, currency: string) {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function day(seconds: number | null) {
  if (!seconds) return null;
  return new Date(seconds * 1000).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * The subscriber's controls on the plan card: what they pay and when it renews, switching
 * between Pro and Max (on Stripe's own confirmation page, which shows the exact prorated
 * charge first), cancel, or undo a cancellation. The portal stays for card and invoices.
 *
 * Reads the subscription from Stripe on mount rather than from the page, so the settings
 * page never waits on Stripe, and so a cancellation made in the portal shows up here.
 */
export function SubscriptionManager() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [flow, setFlow] = useState<Flow>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    getSubscriptionOverview()
      .then((result) => {
        if (!live) return;
        if (result.ok) setOverview(result);
        else setLoadError(result.error);
      })
      .catch((err) => live && setLoadError(friendlyError(err, UNAVAILABLE)));
    return () => {
      live = false;
    };
  }, [attempt]);

  const retry = () => {
    setLoadError(null);
    setAttempt((n) => n + 1);
  };

  const applied = (subscription: SubscriptionDetails) =>
    setOverview((prev) => (prev ? { ...prev, subscription } : prev));

  if (loadError) {
    return (
      <div className="flex w-full flex-col gap-3">
        <p className="text-sm text-muted-foreground">{loadError}</p>
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" size="sm" onClick={retry}>
            Try again
          </Button>
          <ManageBillingButton />
        </div>
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="flex w-full flex-col gap-3" aria-busy="true" aria-label="Loading your subscription">
        <Skeleton className="h-4 w-64 max-w-full" />
        <div className="flex gap-3">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-7 w-28" />
        </div>
      </div>
    );
  }

  const sub = overview.subscription;
  const other: PurchasablePlan = sub.plan === "max" ? "orbit" : "max";
  const endsOn = day(sub.periodEnd);

  return (
    <div className="flex w-full flex-col gap-3">
      <SubscriptionSummary sub={sub} />

      {sub.cancelAtPeriodEnd ? (
        <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/40 p-3">
          <p className="text-sm text-muted-foreground">
            Your subscription is canceled. You keep {PLAN_LABELS[sub.plan]}{endsOn ? ` until ${endsOn}` : " until the end of this period"},
            then the account moves to Free.
          </p>
          <div className="flex flex-wrap gap-3">
            <ResumeButton onResumed={applied} />
            <ManageBillingButton />
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <SwitchPlanButton target={other} />
          <ManageBillingButton />
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => setFlow("cancel")}
          >
            Cancel subscription
          </Button>
        </div>
      )}

      <CancelDialog
        open={flow === "cancel"}
        onOpenChange={(open) => setFlow(open ? "cancel" : null)}
        endsOn={endsOn}
        planLabel={PLAN_LABELS[sub.plan]}
        onCanceled={applied}
      />
    </div>
  );
}

function SubscriptionSummary({ sub }: { sub: SubscriptionDetails }) {
  const price =
    sub.amountCents !== null
      ? `${money(sub.amountCents, sub.currency)} ${sub.period === "annual" ? "per year" : "per month"}`
      : null;
  const date = day(sub.periodEnd);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted-foreground">Plan</dt>
      <dd className="text-ink">{PLAN_LABELS[sub.plan]}</dd>
      <dt className="text-muted-foreground">Billing</dt>
      <dd className="text-ink">
        {sub.period === "annual" ? "Annual" : "Monthly"}
        {price && <span className="text-muted-foreground"> · {price}</span>}
      </dd>
      {date && (
        <>
          <dt className="text-muted-foreground">{sub.cancelAtPeriodEnd ? "Ends" : "Renews"}</dt>
          <dd className="text-ink">{date}</dd>
        </>
      )}
      {sub.status === "past_due" && (
        <>
          <dt className="text-muted-foreground">Payment</dt>
          <dd className="text-destructive">Last payment didn’t go through — update your card under Manage billing</dd>
        </>
      )}
    </dl>
  );
}

/**
 * Pro → Max is immediate and prorated; Max → Pro takes effect at the end of the period. Both
 * are decided by the portal configuration and shown on Stripe's page before anything
 * changes, so this button only opens it.
 */
function SwitchPlanButton({ target }: { target: PurchasablePlan }) {
  const [pending, start] = useTransition();
  const label = target === "max" ? "Upgrade to Max" : "Switch to Pro";
  return (
    <Button
      size="sm"
      variant={target === "max" ? "default" : "outline"}
      disabled={pending}
      onClick={() =>
        start(async () => {
          try {
            const result = await startPlanSwitch(target);
            if ("url" in result) {
              // A full navigation: the destination is Stripe's domain.
              window.location.href = result.url;
              return;
            }
            toast.error(result.error);
          } catch (err) {
            toast.error(friendlyError(err, UNAVAILABLE));
          }
        })
      }
    >
      {pending && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
      {label}
    </Button>
  );
}

function ResumeButton({ onResumed }: { onResumed: (sub: SubscriptionDetails) => void }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          try {
            const result = await resumeSubscription();
            if (!result.ok) {
              toast.error(result.error);
              return;
            }
            onResumed(result.subscription);
            toast.success("Your subscription will renew as usual");
          } catch (err) {
            toast.error(friendlyError(err, UNAVAILABLE));
          }
        })
      }
    >
      {pending && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
      Resume subscription
    </Button>
  );
}

function CancelDialog({
  open,
  onOpenChange,
  endsOn,
  planLabel,
  onCanceled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  endsOn: string | null;
  planLabel: string;
  onCanceled: (sub: SubscriptionDetails) => void;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel {planLabel}?</DialogTitle>
          <DialogDescription>
            You won’t be charged again. {planLabel} stays on {endsOn ? `until ${endsOn}` : "until the end of the period you’ve paid for"},
            then your account moves to Free.
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Every contact, note and reminder stays exactly where it is.</li>
          <li>
            Free adds new contacts up to {FREE_CONTACT_LIMIT.toLocaleString("en-US")}. Included AI, recruiter
            tracking, meetings and a second Google or Microsoft account pause until you upgrade again.
          </li>
          <li>Credits from packs you bought are kept, frozen, and come back when you resubscribe.</li>
          <li>You can change your mind any time before then.</li>
        </ul>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => onOpenChange(false)}>
            Keep {planLabel}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={() =>
              start(async () => {
                setError(null);
                try {
                  const result = await cancelSubscription();
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  onCanceled(result.subscription);
                  onOpenChange(false);
                  toast.success(
                    endsOn ? `Subscription canceled — ${planLabel} stays on until ${endsOn}` : "Subscription canceled"
                  );
                } catch (err) {
                  setError(friendlyError(err, UNAVAILABLE));
                }
              })
            }
          >
            {pending && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
            Cancel subscription
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
