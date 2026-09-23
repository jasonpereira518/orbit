"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useClerk } from "@clerk/nextjs";
import { clerkErrorMessage } from "@/lib/clerk-errors";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";

const SIGN_IN = "/settings/account/sign-in";

/**
 * Finishes Clerk's OAuth handshake, then returns to the Sign-in screen either way.
 *
 * The brief's first draft mounted `<AuthenticateWithRedirectCallback>` and let it call
 * `clerk.handleRedirectCallback` on its own. That component's installed implementation
 * (`node_modules/@clerk/react/dist/ClerkProvider-BhtPIGJT.mjs:131-136`) is:
 *
 *   React.useEffect(() => { clerk.handleRedirectCallback(params); }, []);
 *   return null;
 *
 * No `.catch()`, no error state, renders nothing — so a denied consent, a network error, or
 * the wrong LinkedIn strategy (`connected-accounts.tsx`'s unconfirmed spelling) left the
 * screen stuck on "Finishing up…" forever. Clerk's own prebuilt sign-in callback
 * (`@clerk/ui/dist/common/SSOCallback.js`) wraps the identical call in
 * `.catch((e) => { handleError(...); setTimeout(() => navigate("../"), 4000); })`, which is
 * itself the evidence that the promise rejects on failure. This component owns the call
 * instead, so failure has somewhere to go.
 *
 * `handleRedirectCallback(params, customNavigate?) => Promise<unknown>`
 * (`@clerk/shared/dist/types/clerk.d.mts:937`) takes `HandleOAuthCallbackParams |
 * HandleSamlCallbackParams` — the two are the same type (`clerk.d.mts` right below `:1033`).
 * Its fields (`continueSignUpUrl`, `signInFallbackRedirectUrl`, `signUpFallbackRedirectUrl`,
 * `signInUrl`, `firstFactorUrl`, `resetPasswordUrl`, `reloadResource`, …) are all about
 * completing a sign-in or sign-up transaction. This callback never runs one: the user is
 * already signed in, and `createExternalAccount` in `connected-accounts.tsx` is linking a
 * new provider to that existing session, not authenticating one. None of those fields apply,
 * so none are passed — an empty params object, with navigation handled here explicitly
 * either way, regardless of what (if anything) Clerk would have done internally for a
 * sign-in/up flow that isn't this one.
 *
 * The effect is guarded by a ref rather than relying on the dependency array to run once:
 * Strict Mode double-invokes effects in development, and calling `handleRedirectCallback`
 * twice against the same one-time OAuth code would make the second call fail. `clerk` itself
 * is safe to depend on — unlike `useUser()`/`useSession()`, whose resources get a new
 * identity on every Clerk emission (see `devices-list.tsx`'s comment), `useClerk()` returns
 * the same SDK instance for the life of the provider.
 */
export function SsoReturn() {
  const clerk = useClerk();
  const router = useRouter();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    clerk
      .handleRedirectCallback({})
      .catch((err: unknown) => {
        toast.error(clerkErrorMessage(err, friendlyError(err, "Couldn’t connect that account — try again?")));
      })
      .finally(() => {
        router.replace(SIGN_IN);
      });
  }, [clerk, router]);

  return (
    <div className="space-y-2 p-6">
      <p className="text-sm text-muted-foreground">Finishing up…</p>
      <Link href={SIGN_IN} className="text-sm underline underline-offset-4">
        Back to sign-in
      </Link>
    </div>
  );
}
