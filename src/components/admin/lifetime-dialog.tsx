"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Crown, Loader2 } from "lucide-react";
import {
  grantLifetimeAction,
  previewLifetimeAction,
  revokeLifetimeAction,
  type LifetimePreview,
} from "@/actions/admin";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { friendlyError } from "@/lib/errors";
import { PLAN_LABELS } from "@/lib/plans/plan-config";
import { toast } from "@/lib/toast";

function day(seconds: number | null) {
  if (!seconds) return "the end of the period they have paid for";
  return new Date(seconds * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/**
 * Grant or revoke Orbit Lifetime — admin-assigned only (pricing v2). Both are confirmed
 * against a PREVIEW read when the dialog opens, so the admin sees exactly what will happen to
 * this account before anything changes, and both are written to the audit log. There is no
 * "why" field: the server records a default reason, which is the audit row's honest fallback.
 */
export function LifetimeButton({ targetUserId, hasLifetime }: { targetUserId: string; hasLifetime: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Crown className="size-3.5" aria-hidden />
        {hasLifetime ? "Revoke Lifetime" : "Grant Lifetime"}
      </Button>
      {open && <LifetimeDialog targetUserId={targetUserId} mode={hasLifetime ? "revoke" : "grant"} onClose={() => setOpen(false)} />}
    </>
  );
}

export function LifetimeDialog({
  targetUserId,
  mode,
  onClose,
}: {
  targetUserId: string;
  mode: "grant" | "revoke";
  onClose: () => void;
}) {
  const router = useRouter();
  const [preview, setPreview] = useState<LifetimePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includePurchase, setIncludePurchase] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    previewLifetimeAction(targetUserId)
      .then((p) => live && setPreview(p))
      .catch((err) => live && setError(friendlyError(err, "Couldn’t read this account — try again?")));
    return () => {
      live = false;
    };
  }, [targetUserId]);

  const sub = preview?.subscription;
  const effects: string[] = [];
  if (preview && mode === "grant") {
    effects.push(`Their plan changes from ${PLAN_LABELS[preview.plan]} to Orbit Lifetime now: every Max feature, with AI on their own key only (no credits, no packs).`);
    if (sub?.kind === "ends_at_period_end") {
      effects.push(
        sub.alreadyEnding
          ? `Their ${PLAN_LABELS[sub.plan]} subscription is already set to end on ${day(sub.periodEnd)}; nothing else is charged.`
          : `Their ${PLAN_LABELS[sub.plan]} subscription stops renewing and ends on ${day(sub.periodEnd)}. No refund for the current period, and no further charge.`
      );
    } else if (sub?.kind === "none") {
      effects.push("They have no live subscription, so nothing changes in Stripe.");
    } else if (sub?.kind === "error") {
      effects.push("Stripe could not be reached to check for a subscription — check it in Stripe after granting.");
    }
    effects.push("Any unused pack credits are kept, frozen, while they are on Lifetime.");
  }
  if (preview && mode === "revoke") {
    effects.push("They fall back to their real billing state (usually the Free Plan). Nothing they have made is hidden or deleted.");
    if (preview.purchasedLifetime) {
      effects.push("They BOUGHT Lifetime before pricing v2. Revoking the purchase too needs the box below; otherwise only a comped Lifetime is removed.");
    }
    effects.push("A subscription the grant set to end is not restarted; they can subscribe again.");
  }

  const canSubmit = preview !== null && (mode === "grant" || preview.compedLifetime || (preview.purchasedLifetime && includePurchase));

  const submit = () =>
    start(async () => {
      try {
        if (mode === "grant") {
          const res = await grantLifetimeAction({ targetUserId, reason: "" });
          toast.success(
            res.subscription === "error"
              ? "Lifetime granted — but the subscription couldn’t be set to end; do it in Stripe"
              : "Lifetime granted"
          );
        } else {
          const res = await revokeLifetimeAction({ targetUserId, reason: "", includePurchase });
          toast.success(`Lifetime revoked — now on ${PLAN_LABELS[res.plan]}`);
        }
        onClose();
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t change the plan — try again?"));
      }
    });

  return (
    <Dialog open onOpenChange={(next) => !next && !pending && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === "grant" ? "Grant Orbit Lifetime?" : "Revoke Orbit Lifetime?"}</DialogTitle>
          <DialogDescription>{preview?.email ?? targetUserId} · this is what will happen:</DialogDescription>
        </DialogHeader>

        {error ? (
          <p role="alert" className="text-sm text-destructive">{error}</p>
        ) : !preview ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> Checking the account and Stripe…
          </p>
        ) : (
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            {effects.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}

        {mode === "revoke" && preview?.purchasedLifetime && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={includePurchase} onChange={(e) => setIncludePurchase(e.target.checked)} className="mt-1" />
            <span>Also revoke the Lifetime they paid for. This does not refund them.</span>
          </label>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !canSubmit} variant={mode === "revoke" ? "destructive" : "default"}>
            {pending ? "Saving…" : mode === "grant" ? "Grant Lifetime" : "Revoke Lifetime"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
