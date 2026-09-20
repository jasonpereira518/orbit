"use client";

import { useEffect, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  cancelSubscription,
  changeBillingPeriod,
  getSubscriptionOverview,
  previewBillingPeriodChange,
  resumeSubscription,
  startLifetimeCheckout,
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
import { ANNUAL_SAVING_PERCENT, type BillingPeriod } from "@/lib/plan-copy";
import { FREE_CONTACT_LIMIT } from "@/lib/plan-limits";
import type { SubscriptionDetails } from "@/lib/subscription-management";

type Overview = Extract<SubscriptionOverview, { ok: true }>;
type Flow = null | "cancel" | "switch" | "lifetime";

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
 * The Pro subscriber's controls on the plan card: what they pay and when it renews, and in
 * place of a trip to Stripe's portal for the common cases — switch monthly ↔ annual, move to
 * Lifetime, cancel, or undo a cancellation. The portal stays for card and invoices.
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
  const other: BillingPeriod = sub.period === "annual" ? "monthly" : "annual";
  const endsOn = day(sub.periodEnd);

  return (
    <div className="flex w-full flex-col gap-3">
      <SubscriptionSummary sub={sub} />

      {sub.cancelAtPeriodEnd ? (
        <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/40 p-3">
          <p className="text-sm text-muted-foreground">
            Your subscription is canceled. You keep Orbit Pro{endsOn ? ` until ${endsOn}` : " until the end of this period"},
            then the account moves to Free.
          </p>
          <div className="flex flex-wrap gap-3">
            <ResumeButton onResumed={applied} />
            <ManageBillingButton />
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {overview.canSwitchPeriod && (
            <Button size="sm" variant={other === "annual" ? "default" : "outline"} onClick={() => setFlow("switch")}>
              {other === "annual"
                ? `Switch to annual — save ${ANNUAL_SAVING_PERCENT}%`
                : "Switch to monthly"}
            </Button>
          )}
          {overview.lifetimePriceUsd !== null && (
            <Button size="sm" variant="outline" onClick={() => setFlow("lifetime")}>
              Switch to Lifetime
            </Button>
          )}
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
        onCanceled={applied}
      />
      <SwitchPeriodDialog
        open={flow === "switch"}
        onOpenChange={(open) => setFlow(open ? "switch" : null)}
        target={other}
        onSwitched={applied}
      />
      {overview.lifetimePriceUsd !== null && (
        <LifetimeDialog
          open={flow === "lifetime"}
          onOpenChange={(open) => setFlow(open ? "lifetime" : null)}
          priceUsd={overview.lifetimePriceUsd}
          endsOn={endsOn}
        />
      )}
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
  onCanceled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  endsOn: string | null;
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
          <DialogTitle>Cancel Orbit Pro?</DialogTitle>
          <DialogDescription>
            You won’t be charged again. Pro stays on {endsOn ? `until ${endsOn}` : "until the end of the period you’ve paid for"},
            then your account moves to Free.
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Every contact, note and reminder stays exactly where it is.</li>
          <li>
            Free adds new contacts up to {FREE_CONTACT_LIMIT.toLocaleString("en-US")}. Sync, outreach, the
            extension and the API pause until you upgrade again.
          </li>
          <li>You can change your mind any time before then.</li>
        </ul>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => onOpenChange(false)}>
            Keep Pro
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
                    endsOn ? `Subscription canceled — Pro stays on until ${endsOn}` : "Subscription canceled"
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

function SwitchPeriodDialog({
  open,
  onOpenChange,
  target,
  onSwitched,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: BillingPeriod;
  onSwitched: (sub: SubscriptionDetails) => void;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        {/* Keyed on each opening, so the quote is always fetched fresh for this visit. */}
        {open && (
          <SwitchPeriodBody
            target={target}
            onPendingChange={setPending}
            onClose={() => onOpenChange(false)}
            onSwitched={onSwitched}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SwitchPeriodBody({
  target,
  onPendingChange,
  onClose,
  onSwitched,
}: {
  target: BillingPeriod;
  onPendingChange: (pending: boolean) => void;
  onClose: () => void;
  onSwitched: (sub: SubscriptionDetails) => void;
}) {
  const [preview, setPreview] = useState<{ totalCents: number; currency: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    previewBillingPeriodChange(target)
      .then((result) => {
        if (!live) return;
        if (result.ok) setPreview({ totalCents: result.totalCents, currency: result.currency });
        else setPreviewError(result.error);
      })
      .catch((err) => live && setPreviewError(friendlyError(err, UNAVAILABLE)));
    return () => {
      live = false;
    };
  }, [target]);

  useEffect(() => onPendingChange(pending), [pending, onPendingChange]);

  const toAnnual = target === "annual";

  return (
    <>
      <DialogHeader>
        <DialogTitle>{toAnnual ? "Switch to annual billing?" : "Switch to monthly billing?"}</DialogTitle>
        <DialogDescription>
          {toAnnual
            ? `Pay for a year at once and save ${ANNUAL_SAVING_PERCENT}%. What’s left of this month comes off the first charge.`
            : "Monthly billing starts today. What’s left of your year becomes credit that pays your next monthly invoices."}
        </DialogDescription>
      </DialogHeader>

      <div className="rounded-xl border border-border/70 bg-muted/40 p-3 text-sm" aria-live="polite">
        {previewError ? (
          <span className="text-muted-foreground">{previewError}</span>
        ) : !preview ? (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            Working out the amount…
          </span>
        ) : preview.totalCents > 0 ? (
          <span className="text-ink">
            You’ll be charged <strong>{money(preview.totalCents, preview.currency)}</strong> today.
          </span>
        ) : preview.totalCents < 0 ? (
          <span className="text-ink">
            Nothing to pay today. <strong>{money(-preview.totalCents, preview.currency)}</strong> of credit goes
            toward your next invoices.
          </span>
        ) : (
          <span className="text-ink">Nothing to pay today.</span>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter className="gap-2 sm:gap-2">
        <Button variant="ghost" size="sm" disabled={pending} onClick={onClose}>
          Not now
        </Button>
        <Button
          size="sm"
          disabled={pending || !preview}
          onClick={() =>
            start(async () => {
              setError(null);
              try {
                const result = await changeBillingPeriod(target);
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                onSwitched(result.subscription);
                onClose();
                toast.success(toAnnual ? "You’re on annual billing now" : "You’re on monthly billing now");
              } catch (err) {
                setError(friendlyError(err, UNAVAILABLE));
              }
            })
          }
        >
          {pending && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
          {toAnnual ? "Switch to annual" : "Switch to monthly"}
        </Button>
      </DialogFooter>
    </>
  );
}

function LifetimeDialog({
  open,
  onOpenChange,
  priceUsd,
  endsOn,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  priceUsd: number;
  /** The paid-through date the switch forfeits. */
  endsOn: string | null;
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
          <DialogTitle>Switch to Orbit Lifetime?</DialogTitle>
          <DialogDescription>
            Pay ${priceUsd} once and keep Orbit for good. An account has one plan at a time, so Lifetime replaces Pro
            the moment it’s paid.
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>
            Your Pro subscription is canceled right away and won’t renew.
            {endsOn ? ` The days left until ${endsOn} aren’t refunded.` : " The rest of this period isn’t refunded."}
          </li>
          <li>Contact enrichment moves to your own Apollo key. Everything else in Pro is included.</li>
        </ul>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => onOpenChange(false)}>
            Not now
          </Button>
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              start(async () => {
                setError(null);
                try {
                  const result = await startLifetimeCheckout({ replaceSubscription: true });
                  if ("url" in result) {
                    // A full navigation: the destination is Stripe's domain.
                    window.location.href = result.url;
                    return;
                  }
                  setError(result.error);
                } catch (err) {
                  setError(friendlyError(err, "Couldn’t start checkout — try again"));
                }
              })
            }
          >
            {pending && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
            {pending ? "Opening checkout…" : `Continue to payment — $${priceUsd}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
