"use client";

import { useState } from "react";
import { useUser } from "@clerk/nextjs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clerkErrorMessage } from "@/lib/clerk-errors";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";

/**
 * Two steps, because Clerk's flow has two: create the address, then prove it with the code
 * Clerk mails. The created-but-unverified address is real and already on the account, so
 * abandoning step two — Cancel, Escape, the backdrop, or just navigating away — leaves it
 * listed as Unverified rather than losing it, which is why `EmailList` renders that badge
 * and lets an unverified address be removed freely.
 *
 * `createEmailAddress` takes only `{ email }` (`CreateEmailAddressParams`,
 * `@clerk/shared/dist/types/user.d.mts:336`). `prepareVerification({ strategy: "email_code" })`
 * needs no `redirectUrl` for that strategy (`PrepareEmailAddressVerificationParams`,
 * `@clerk/shared/dist/types/emailAddress.d.mts`). `attemptVerification({ code })` matches
 * `AttemptEmailAddressVerificationParams` exactly. `user.reload()` comes from the base
 * `ClerkResource` (`@clerk/shared/dist/types/resource.d.mts:21`), the same call `EmailList`
 * makes after its own mutations.
 *
 * A programmatic `setOpen(false)` — Cancel, or the success path below — does not run through
 * Base UI's `onOpenChange`: that prop only fires for the library's own close triggers
 * (Escape, the backdrop, the header's X button); see `useDialogRoot.js`, which calls
 * `store.setOpen` (and so `onOpenChange`) only from those internal interactions, while a
 * controlled `open` prop change from outside is just synced, not echoed back. So every place
 * this file closes the dialog itself also calls `reset()` directly, rather than trusting
 * `onOpenChange` to catch it.
 *
 * Cancel is disabled while a request is in flight — the same guard `delete-account-dialog.tsx`
 * puts on its own Cancel button. Without it, a Cancel click during `sendCode()` ran `close()`
 * immediately (clearing `address`/`code`/`pendingId`), but the in-flight `createEmailAddress`
 * call was not cancelled and this component never unmounts (only the Base UI popup portal
 * does) — so it resolved anyway, silently re-arming `pendingId` and toasting success after
 * the user believed they had cancelled. Locking Cancel behind `working` closes that window.
 */
export function AddEmailDialog({ trigger }: { trigger: React.ReactNode }) {
  const { isLoaded, user } = useUser();
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const reset = () => {
    setAddress("");
    setCode("");
    setPendingId(null);
    setWorking(false);
  };

  const close = () => {
    setOpen(false);
    reset();
  };

  const sendCode = async () => {
    if (!isLoaded || !user || address.trim().length === 0) return;
    setWorking(true);
    try {
      const created = await user.createEmailAddress({ email: address.trim() });
      await created.prepareVerification({ strategy: "email_code" });
      setPendingId(created.id);
      toast.success("Code sent — check that inbox");
    } catch (err) {
      toast.error(clerkErrorMessage(err, friendlyError(err, TOAST_COPY.saveFailed)));
    } finally {
      setWorking(false);
    }
  };

  const confirm = async () => {
    if (!isLoaded || !user || !pendingId || code.trim().length === 0) return;
    setWorking(true);
    try {
      const email = user.emailAddresses.find((e) => e.id === pendingId);
      if (!email) throw new Error("The pending address is gone");
      await email.attemptVerification({ code: code.trim() });
      await user.reload();
      toast.success("Address added");
      close();
    } catch (err) {
      toast.error(clerkErrorMessage(err, friendlyError(err, TOAST_COPY.saveFailed)));
    } finally {
      setWorking(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <span onClick={() => setOpen(true)}>{trigger}</span>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add an email address</DialogTitle>
          <DialogDescription aria-live="polite">
            {pendingId
              ? "Enter the six-digit code we sent, and the address is yours"
              : "We’ll send a code to make sure it’s really yours"}
          </DialogDescription>
        </DialogHeader>

        {pendingId ? (
          <div className="space-y-1.5">
            <Label htmlFor="add-email-code">Verification code</Label>
            <Input
              id="add-email-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="add-email-address">Email address</Label>
            <Input
              id="add-email-address"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" disabled={working} onClick={close}>
            Cancel
          </Button>
          {pendingId ? (
            <Button
              type="button"
              size="sm"
              disabled={!isLoaded || working || code.trim().length === 0}
              onClick={() => void confirm()}
            >
              {working ? "Checking…" : "Confirm"}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={!isLoaded || working || address.trim().length === 0}
              onClick={() => void sendCode()}
            >
              {working ? "Sending…" : "Send code"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
