"use client";

import { useState } from "react";
import { useUser, useReverification } from "@clerk/nextjs";
import { isReverificationCancelledError } from "@clerk/nextjs/errors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { canRemoveEmail, type SignInMethods } from "@/lib/sign-in-methods";
import { clerkErrorMessage } from "@/lib/clerk-errors";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";

/**
 * The addresses on the account.
 *
 * Reads Clerk's user resource directly — no local copy of the list, so `user.reload()` after
 * a mutation is the whole refresh story. The lockout rules live in `@/lib/sign-in-methods` so
 * they can be tested without a browser; this file only renders their verdicts.
 *
 * `EmailAddressResource.verification` (`@clerk/shared/dist/types/emailAddress.d.mts`) is a
 * required `VerificationResource`, not an optional field — but its `status` is typed
 * `VerificationStatus | null` (`@clerk/shared/dist/types/verification.d.mts`), so the check
 * below still needs a null-safe comparison. `"verified"` is one of the five literal values of
 * `VerificationStatus`.
 */
export function EmailList() {
  const { isLoaded, user } = useUser();
  const [busy, setBusy] = useState<string | null>(null);

  const setPrimary = useReverification((emailId: string) =>
    user ? user.update({ primaryEmailAddressId: emailId }) : Promise.resolve(null)
  );
  const removeEmail = useReverification(async (emailId: string) => {
    const email = user?.emailAddresses.find((e) => e.id === emailId);
    if (!email) return false;
    await email.destroy();
    return true;
  });

  if (!isLoaded) {
    return <div className="h-20 animate-pulse rounded-lg bg-muted/40" aria-hidden />;
  }
  if (!user) return null;

  const methods: SignInMethods = {
    emails: user.emailAddresses.map((e) => ({
      id: e.id,
      verified: e.verification.status === "verified",
    })),
    externalAccountIds: user.externalAccounts.map((a) => a.identificationId),
    hasPassword: user.passwordEnabled,
    primaryEmailId: user.primaryEmailAddressId,
  };

  /**
   * `run` reports whether it actually changed anything — `removeEmail` returns `false` when
   * the address was already gone (the TOCTOU window below can reach that). A `false` still
   * reloads, because the stale row that prompted the click needs to disappear from the list
   * either way, but it does not get a success toast: nothing happened on THIS call, and a
   * toast that says otherwise is a lie regardless of what some other call already did.
   */
  const act = async (emailId: string, run: () => Promise<boolean>, done: string) => {
    setBusy(emailId);
    try {
      const changed = await run();
      await user.reload();
      if (changed) toast.success(done);
    } catch (err) {
      // A person who backs out of Clerk's "confirm it's you" prompt chose to stop; that is
      // not a failure and gets no toast.
      if (isReverificationCancelledError(err)) return;
      toast.error(clerkErrorMessage(err, friendlyError(err, TOAST_COPY.saveFailed)));
    } finally {
      setBusy(null);
    }
  };

  if (user.emailAddresses.length === 0) {
    return <p className="text-sm text-muted-foreground">No email addresses on this account</p>;
  }

  return (
    <ul className="divide-y divide-border/60">
      {user.emailAddresses.map((email) => {
        const verified = email.verification.status === "verified";
        const isPrimary = user.primaryEmailAddressId === email.id;
        const removal = canRemoveEmail(methods, email.id);
        const working = busy === email.id;
        // Any mutation in flight disables every row, not just its own — the same guard
        // `devices-list.tsx` uses (`disabled={busy !== null}`). A single shared `busy`
        // scalar means a second row read as idle while the first is still in flight, which
        // let a click fire a concurrent second mutation on the busy row, and let two rows'
        // clicks each evaluate `canRemoveEmail` against the same un-reloaded snapshot — the
        // TOCTOU window that could drop the account to zero verified emails.
        const anyBusy = busy !== null;
        const reasonId = `email-remove-reason-${email.id}`;

        return (
          <li key={email.id} className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
                <span className="truncate font-medium">{email.emailAddress}</span>
                {isPrimary && <Badge variant="secondary">Primary</Badge>}
                {!verified && <Badge variant="outline">Unverified</Badge>}
              </p>
            </div>
            {verified && !isPrimary && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={anyBusy}
                aria-label={`Make ${email.emailAddress} primary`}
                onClick={() =>
                  void act(
                    email.id,
                    () => setPrimary(email.id).then(() => true),
                    "Primary address changed"
                  )
                }
              >
                {working ? "Working…" : "Make primary"}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={anyBusy || !removal.allowed}
              title={removal.allowed ? undefined : removal.reason}
              aria-label={`Remove ${email.emailAddress}`}
              aria-describedby={removal.allowed ? undefined : reasonId}
              onClick={() => void act(email.id, () => removeEmail(email.id), "Address removed")}
            >
              {working ? "Working…" : "Remove"}
            </Button>
            {!removal.allowed && (
              <p id={reasonId} className="w-full text-xs text-muted-foreground">
                {removal.reason}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
