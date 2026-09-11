"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
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
  /**
   * Label for the solid button. The page's ending says "Start free" — the closing ask
   * leads with what it costs — while the hero and header keep "Get Started".
   */
  primaryLabel?: string;
  /**
   * "link" demotes Sign in from a pill beside the primary button to a quiet line under
   * it. For the ending, where returning visitors already have the header's Sign in and a
   * second pill only competes with the ask.
   */
  signInAs?: "button" | "link";
  /**
   * Shown under the primary button to signed-OUT visitors only: the reassurance that
   * belongs at the decision point ("No card required"). A signed-in visitor has nothing
   * left to decide, so it never renders for them.
   */
  note?: React.ReactNode;
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
  primaryLabel = "Get Started",
  signInAs = "button",
  note,
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

  // Both signed-out paths render the same controls, so a local demo-mode run shows exactly
  // what a stranger sees in production.
  const signedOut = (signInHref: string, signUpHref: string) =>
    signInAs === "link" ? (
      <div className="flex w-full flex-col items-center sm:w-auto">
        <Link href={signUpHref} className={cn(solid, "w-full px-8 text-base sm:w-auto")}>
          {primaryLabel}
        </Link>
        {note}
        <p className="mt-3 text-sm text-[#9aada8]">
          Already have an account?{" "}
          <Link
            href={signInHref}
            className="text-[#e8f3f1] underline underline-offset-4 transition-opacity hover:opacity-80"
          >
            Sign in
          </Link>
        </p>
      </div>
    ) : (
      <>
        <div className={wrapClass}>
          <Link href={signInHref} className={ghost}>
            Sign in
          </Link>
          <Link href={signUpHref} className={solid}>
            {primaryLabel}
          </Link>
        </div>
        {note}
      </>
    );

  if (!clerkOn) {
    const href = demoMode ? "/dashboard" : "/sign-in";
    return signedOut(href, href);
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

  return signedOut("/sign-in", "/sign-up");
}
