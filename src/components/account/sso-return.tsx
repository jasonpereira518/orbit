"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { providerKey } from "@/lib/clerk-sign-in-methods";
import { clerkApiErrorMessage, clerkErrorMessage } from "@/lib/clerk-errors";
import { friendlyError } from "@/lib/errors";
import { takePendingConnect } from "@/lib/pending-connect";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";

const SIGN_IN = "/settings/account/sign-in";

/**
 * The return leg of connecting a provider: refresh the user, say what happened, go back.
 *
 * Two earlier drafts called `clerk.handleRedirectCallback` here — first via
 * `<AuthenticateWithRedirectCallback>`, then directly. Both were wrong, because that method
 * completes a transaction this flow never starts. Its own doc
 * (`@clerk/shared/dist/types/clerk.d.mts:932-937`) says it "Completes a custom OAuth or SAML
 * redirect flow that was started by calling `SignIn.authenticateWithRedirect(params)` or
 * `SignUp.authenticateWithRedirect(params)`" — and this flow starts with
 * `user.createExternalAccount` on an already-signed-in session, which is neither. Its params
 * (`continueSignUpUrl`, `signInFallbackRedirectUrl`, `firstFactorUrl`, `resetPasswordUrl`, …)
 * are all about a sign-in or sign-up that does not exist here. Likely outcomes were a rejected
 * promise toasting "Couldn't connect that account" for a link that had just succeeded, or
 * Clerk's default navigation — Clerk's own `SSOCallback` passes a `navigate` as the second
 * argument (`@clerk/ui/dist/common/SSOCallback.js:28-31`) and we passed none — pulling the
 * person out of settings while `router.replace` fought it.
 *
 * Clerk's own connected-accounts flow never calls it. It either opens a popup and then calls
 * `reloadUserAfterOAuthCallback(user, callbackUrl)`, or does a plain full-page navigate back
 * with no callback handling at all
 * (`@clerk/ui/dist/components/UserProfile/ConnectedAccountsMenu.js:45-54`). This mirrors that
 * helper exactly (`@clerk/ui/dist/components/UserProfile/oauthTransport.js:9-16`):
 *
 *   const nonce = new URL(callbackUrl).searchParams.get("rotating_token_nonce");
 *   if (nonce) { await user.reload({ rotatingTokenNonce: nonce }); return; }
 *   await user.reload();
 *
 * `rotatingTokenNonce` is the one field `ClerkResourceReloadParams` has
 * (`@clerk/shared/dist/types/resource.d.mts:3-8`), and `reload(p?)` takes it optionally
 * (`:21`), so the nonce-less path passes nothing rather than an empty object.
 *
 * A refused consent does NOT reject anything here — Clerk records it on the external account
 * as `verification.error`, which is what the outcome below reads and what the Sign-in screen
 * renders as a failed row. The reload rejecting is a different thing entirely (the refresh
 * itself failed, outcome unknown) and says so.
 *
 * The effect is guarded by a ref rather than the dependency array: Strict Mode double-invokes
 * effects in development, and `useUser()`'s resource gets a new identity on every Clerk
 * emission (see `devices-list.tsx`'s comment), so the deps alone would not hold it to one run.
 */
export function SsoReturn() {
  const { isLoaded, user } = useUser();
  const router = useRouter();
  const ran = useRef(false);

  useEffect(() => {
    if (!isLoaded || ran.current) return;
    ran.current = true;

    // Signed out by the time we got back: nothing to reload, and the Sign-in screen's own
    // gate is the right place to land.
    if (!user) {
      router.replace(SIGN_IN);
      return;
    }

    // What we set out to connect, stashed before the browser left. Absent if storage was
    // blocked, or if this route was opened directly — in which case the reload still runs and
    // nothing is claimed about an outcome.
    const pending = takePendingConnect();

    void (async () => {
      const nonce = new URLSearchParams(window.location.search).get("rotating_token_nonce");
      let refreshed;
      try {
        // `reload` is typed `Promise<this>`, so the resolved value is the refreshed resource.
        // Reading it rather than the captured `user` keeps this correct whether Clerk reloads
        // in place or hands back a new instance.
        refreshed = await user.reload(nonce ? { rotatingTokenNonce: nonce } : undefined);
      } catch (err) {
        toast.error(
          clerkErrorMessage(
            err,
            friendlyError(err, "Couldn’t refresh your account — reload the page to check")
          )
        );
        router.replace(SIGN_IN);
        return;
      }

      if (pending) {
        const key = providerKey(pending.provider);
        const linked = refreshed.verifiedExternalAccounts.some(
          (a) => providerKey(a.providerSlug()) === key
        );
        const refused = refreshed.unverifiedExternalAccounts.find(
          (a) => providerKey(a.providerSlug()) === key && a.verification?.error
        );
        if (linked) {
          toast.success(`${pending.label} connected`);
        } else if (refused) {
          toast.error(
            clerkApiErrorMessage(
              refused.verification?.error,
              friendlyError(refused.verification?.error, TOAST_COPY.connectFailed)
            )
          );
        }
        // Neither: the consent screen was closed without an answer, so nothing happened and
        // nothing is said about it.
      }

      router.replace(SIGN_IN);
    })();
  }, [isLoaded, user, router]);

  return (
    <div className="space-y-2 p-6">
      <p className="text-sm text-muted-foreground">Finishing up…</p>
      <Link href={SIGN_IN} className="text-sm underline underline-offset-4">
        Back to sign-in
      </Link>
    </div>
  );
}
