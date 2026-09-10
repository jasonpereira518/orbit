"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, ReceiptText } from "lucide-react";
import {
  previewClerkReconciliationAction,
  previewStripeLifetimeAction,
  reconcileClerkAction,
  reconcileStripeLifetimeAction,
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/toast";
import type {
  ClerkReconciliationPreview,
  StripeLifetimePreview,
} from "@/lib/admin-reconciliation";

const ACTION_BUTTON = "inline-flex items-center gap-1.5 rounded-md border border-border/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground";

export function ReconciliationActions({ targetUserId }: { targetUserId: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      <ClerkReconciliation targetUserId={targetUserId} />
      <StripeReconciliation targetUserId={targetUserId} />
    </div>
  );
}

function ClerkReconciliation({ targetUserId }: { targetUserId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<ClerkReconciliationPreview | null>(null);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  const load = () => {
    setOpen(true);
    setPreview(null);
    startTransition(async () => {
      try {
        setPreview(await previewClerkReconciliationAction(targetUserId));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Clerk could not be checked.");
      }
    });
  };
  const apply = () => startTransition(async () => {
    try {
      await reconcileClerkAction({ targetUserId, reason });
      toast.success("Clerk state reconciled.");
      setOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Reconciliation failed.");
    }
  });

  return (
    <>
      <button type="button" onClick={load} className={ACTION_BUTTON}>
        <RefreshCw className="size-3" aria-hidden /> Reconcile Clerk
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Reconcile from Clerk</DialogTitle>
            <DialogDescription>Compare the canonical identity and subscription with Orbit before applying any changes.</DialogDescription>
          </DialogHeader>
          {pending && !preview ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Reading Clerk…</p>
          ) : preview ? (
            <div className="space-y-4">
              {preview.changes.length === 0 ? (
                <p className="rounded-lg bg-muted px-3 py-3 text-sm">This account is already in sync.</p>
              ) : (
                <div className="overflow-hidden rounded-lg border border-border/70">
                  {preview.changes.map((change) => (
                    <div key={change.field} className="grid grid-cols-[8rem_1fr] gap-3 border-b border-border/50 px-3 py-2 text-xs last:border-b-0">
                      <span className="font-mono text-muted-foreground">{change.field}</span>
                      <span className="min-w-0 break-all"><span className="text-muted-foreground line-through">{change.from ?? "null"}</span><span className="mx-2">→</span>{change.to ?? "null"}</span>
                    </div>
                  ))}
                </div>
              )}
              {preview.changes.length > 0 && (
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium">Reason</span>
                  <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} placeholder="Why is this reconciliation needed?" />
                </label>
              )}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
            <Button size="sm" disabled={pending || !preview || preview.changes.length === 0 || reason.trim().length < 8} onClick={apply}>{pending ? "Applying…" : "Apply changes"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function StripeReconciliation({ targetUserId }: { targetUserId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<StripeLifetimePreview | null>(null);
  const [pending, startTransition] = useTransition();

  const inspect = () => startTransition(async () => {
    try {
      setPreview(await previewStripeLifetimeAction({ targetUserId, sessionId }));
    } catch (error) {
      setPreview(null);
      toast.error(error instanceof Error ? error.message : "Stripe could not verify this session.");
    }
  });
  const apply = () => startTransition(async () => {
    try {
      await reconcileStripeLifetimeAction({ targetUserId, sessionId, reason });
      toast.success("Lifetime purchase reconciled.");
      setOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Reconciliation failed.");
    }
  });

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={ACTION_BUTTON}>
        <ReceiptText className="size-3" aria-hidden /> Reconcile Lifetime
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Reconcile a Lifetime purchase</DialogTitle>
            <DialogDescription>Orbit verifies the exact Checkout Session, payment state, product metadata, and target account before granting anything.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium">Stripe Checkout Session ID</span>
              <div className="flex gap-2">
                <Input value={sessionId} onChange={(event) => { setSessionId(event.target.value); setPreview(null); }} placeholder="cs_live_…" className="font-mono text-xs" />
                <Button type="button" variant="outline" size="sm" onClick={inspect} disabled={pending || !sessionId.trim()}>Verify</Button>
              </div>
            </label>
            {preview && (
              <dl className="rounded-lg border border-border/70 px-3 text-xs">
                <div className="flex justify-between border-b border-border/50 py-2"><dt className="text-muted-foreground">Payment</dt><dd>{preview.paymentStatus}</dd></div>
                <div className="flex justify-between border-b border-border/50 py-2"><dt className="text-muted-foreground">Amount</dt><dd>{preview.amountTotal == null ? "—" : `${preview.amountTotal / 100} ${preview.currency?.toUpperCase()}`}</dd></div>
                <div className="flex justify-between py-2"><dt className="text-muted-foreground">Local state</dt><dd>{preview.alreadyGranted ? "already granted" : "not granted"}</dd></div>
              </dl>
            )}
            {preview && (
              <label className="block space-y-1.5">
                <span className="text-xs font-medium">Reason</span>
                <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} placeholder="Why is this reconciliation needed?" />
              </label>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
            <Button size="sm" disabled={pending || !preview || reason.trim().length < 8} onClick={apply}>{pending ? "Applying…" : "Grant verified Lifetime"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
