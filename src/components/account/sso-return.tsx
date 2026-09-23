"use client";

import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";

/**
 * Finishes Clerk's OAuth handshake, then returns to the Sign-in screen either way.
 *
 * Prop names verified against the installed version — `HandleOAuthCallbackParams`
 * (`@clerk/shared/dist/types/clerk.d.mts:1033`), which is what this component accepts
 * (`@clerk/nextjs` re-exports it from `@clerk/react`, whose props come from the same shared
 * types): `continueSignUpUrl` (`:1057`), `signInFallbackRedirectUrl` and
 * `signUpFallbackRedirectUrl` (`@clerk/shared/dist/types/redirects.d.mts:96-110`) all match
 * what the brief specified — no rename across this Clerk major.
 */
export function SsoReturn() {
  return (
    <div className="p-6">
      <p className="text-sm text-muted-foreground">Finishing up…</p>
      <AuthenticateWithRedirectCallback
        continueSignUpUrl="/settings/account/sign-in"
        signInFallbackRedirectUrl="/settings/account/sign-in"
        signUpFallbackRedirectUrl="/settings/account/sign-in"
      />
    </div>
  );
}
