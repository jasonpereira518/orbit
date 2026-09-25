"use client";

import { useState } from "react";
import Link from "next/link";
import { useClerk } from "@clerk/nextjs";
import { Button, buttonVariants } from "@/components/ui/button";
import { OrbitLogo } from "@/components/orbit-logo";

/**
 * An invitation link opened in a browser that is already signed in to Orbit.
 *
 * Without this, `/sign-up` sends any signed-in visitor into the app, so the invitation is
 * silently spent on nothing: the admin testing their own invite, or anyone sharing a
 * browser, lands in the CURRENT account and the invited address never gets one. Signing
 * out and coming back to the very same URL keeps the `__clerk_ticket`, so `<SignUp/>` then
 * consumes it as intended.
 */
export function InviteSignedInNotice({ email }: { email: string | null }) {
  const { signOut } = useClerk();
  const [pending, setPending] = useState(false);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-background p-6 text-center">
      <OrbitLogo size="lg" />
      <h1 className="font-[family-name:var(--font-display)] text-2xl text-ink">
        You&apos;ve been invited to Orbit
      </h1>
      <p className="max-w-sm text-muted-foreground">
        This browser is signed in{email ? <> as <strong className="text-ink">{email}</strong></> : null}.
        Sign out to create the invited account.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button
          disabled={pending}
          onClick={() => {
            setPending(true);
            void signOut({ redirectUrl: window.location.href });
          }}
        >
          {pending ? "Signing out…" : "Sign out and accept"}
        </Button>
        <Link href="/dashboard" className={buttonVariants({ variant: "outline" })}>
          Stay signed in
        </Link>
      </div>
    </div>
  );
}
