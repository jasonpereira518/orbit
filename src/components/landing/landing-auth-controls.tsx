"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { UserButton, useAuth } from "@clerk/nextjs";
import { clerkAppearance } from "@/lib/clerk-appearance";

const ghostClass =
  "rounded-lg px-3 py-2 text-sm text-[#c5d4d1] transition-colors hover:text-white";
const solidClass =
  "rounded-full bg-[#e8f3f1] px-4 py-2 text-sm font-medium text-[#0f3d3e] transition-colors hover:bg-white";
const ctaSolidClass =
  "inline-flex items-center justify-center rounded-full bg-[#e8f3f1] px-6 py-3 text-sm font-medium text-[#0f3d3e] transition-colors hover:bg-white";
// Pill, to match the solid CTA it always sits beside. (The header's ghost
// stays square-ish — it is a bare text link, so its radius never shows.)
const ctaGhostClass =
  "inline-flex items-center justify-center rounded-full border border-white/20 bg-white/5 px-6 py-3 text-sm text-[#e8f3f1] transition-colors hover:border-white/35 hover:bg-white/10";

/**
 * The marketing pages are static and shared by every visitor, so who is signed in is
 * resolved HERE, in the browser, once Clerk has loaded — not on the server. Signed-out
 * visitors (the audience) see the right buttons from the first frame; the rare signed-in
 * visitor sees them swap to "Open app" a few hundred milliseconds in. `signedIn` remains
 * accepted as a server-known hint for any caller that has one.
 */
type Props = {
  clerkOn: boolean;
  demoMode: boolean;
  signedIn?: boolean;
  variant: "header" | "hero";
  /**
   * Hero variant only. Off by default, so /pricing, /contact and the docs
   * pages keep today's "hidden below sm" behavior untouched. On, the buttons
   * stack full-width below sm — a real tap target instead of nothing.
   */
  mobileVisible?: boolean;
};

/**
 * Entry point. `useAuth()` throws outside a <ClerkProvider>, and the provider is only
 * mounted when Clerk is configured — including at build time, where these pages are now
 * prerendered — so the hook lives in a child that only exists when Clerk does.
 */
export function LandingAuthControls(props: Props) {
  if (!props.clerkOn) return <AuthControlsView {...props} isSignedIn={false} />;
  return <ClerkAwareControls {...props} />;
}

function ClerkAwareControls(props: Props) {
  const auth = useAuth();
  // Clerk reports `undefined` until it has loaded; until then the server-known hint holds.
  const isSignedIn = auth.isSignedIn !== undefined ? auth.isSignedIn : Boolean(props.signedIn);
  return <AuthControlsView {...props} isSignedIn={isSignedIn} />;
}

function AuthControlsView({
  clerkOn,
  demoMode,
  isSignedIn,
  variant,
  mobileVisible = false,
}: Props & { isSignedIn: boolean }) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);

  const solid = variant === "header" ? solidClass : ctaSolidClass;
  const ghost = variant === "header" ? ghostClass : ctaGhostClass;
  const wrapClass =
    variant === "hero"
      ? mobileVisible
        ? "flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:gap-3"
        : "hidden sm:flex sm:w-auto sm:flex-row sm:gap-3"
      : "flex items-center gap-2 sm:gap-3";

  if (!clerkOn) {
    const href = demoMode ? "/dashboard" : "/sign-in";
    return (
      <div className={wrapClass}>
        <Link href={href} className={ghost}>
          Sign in
        </Link>
        <Link href={href} className={solid}>
          Get Started
        </Link>
      </div>
    );
  }

  if (isSignedIn) {
    return (
      <div
        className={
          variant === "hero"
            ? "flex w-full items-center gap-3 sm:w-auto"
            : wrapClass
        }
      >
        <Link href="/dashboard" className={solid}>
          Open app
        </Link>
        <span className="inline-flex size-7 items-center justify-center">
          {hydrated ? (
            <UserButton appearance={clerkAppearance} />
          ) : (
            <span className="size-7 rounded-full bg-white/10" />
          )}
        </span>
      </div>
    );
  }

  return (
    <div className={wrapClass}>
      <Link href="/sign-in" className={ghost}>
        Sign in
      </Link>
      <Link href="/sign-up" className={solid}>
        Get Started
      </Link>
    </div>
  );
}
