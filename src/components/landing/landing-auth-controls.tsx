"use client";

import Link from "next/link";
import { useClerkSessionHint } from "@/lib/clerk-session-hint";
import { cn } from "@/lib/utils";

// On a phone these two are the page's only calls to action until the finale (the hero hides
// its pair below md), and their boxes are 36px tall. The ::after layer adds 4px above and
// below: 44px to a thumb, the same pill to the eye, and still inside the 52px header pill.
const ghostClass =
  "relative rounded-lg px-3 py-2 text-sm text-[#c5d4d1] transition-colors after:absolute after:inset-x-0 after:-inset-y-1 hover:text-white";
const solidClass =
  "relative rounded-full bg-[#e8f3f1] px-4 py-2 text-sm font-medium text-[#0f3d3e] transition-colors after:absolute after:inset-x-0 after:-inset-y-1 hover:bg-white";
const ctaSolidClass =
  "inline-flex items-center justify-center rounded-full bg-[#e8f3f1] px-6 py-3 text-sm font-medium text-[#0f3d3e] transition-colors hover:bg-white";
// Pill, to match the solid CTA it always sits beside. (The header's ghost
// stays square-ish — it is a bare text link, so its radius never shows.)
const ctaGhostClass =
  "inline-flex items-center justify-center rounded-full border border-white/20 bg-white/5 px-6 py-3 text-sm text-[#e8f3f1] transition-colors hover:border-white/35 hover:bg-white/10";

/**
 * The marketing pages are static and shared by every visitor, so who is signed in is
 * resolved HERE, in the browser — not on the server. It comes from Clerk's own
 * `__client_uat` cookie (`useClerkSessionHint`), NOT from Clerk itself: the landing page,
 * /interest and the docs mount no ClerkProvider, so that signed-out strangers download no
 * Clerk JS. Signed-out visitors (the audience) see the right buttons from the first frame;
 * a signed-in visitor sees them swap to "Open app" just after hydration.
 *
 * There is deliberately no avatar menu here any more: `UserButton` needs the provider
 * these pages exist to avoid. The account menu lives in the app, one click away.
 * `signedIn` remains accepted as a server-known hint for any caller that has one.
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
   * Hero variant only: render just the solid button, larger, for a closing ask
   * that already has Sign in and the price in the block above it. Signed in, it
   * is the same "Open app" as everywhere else.
   */
  primaryOnly?: boolean;
  /** The signed-out label of the solid button. */
  primaryLabel?: string;
};

/**
 * Entry point. Safe on any page, with or without a ClerkProvider above it — which is
 * what lets it render in `(site)`, where there is none. Without Clerk configured there is
 * no Clerk session to hint at, and demo mode keeps its own routing below.
 */
export function LandingAuthControls(props: Props) {
  const hinted = useClerkSessionHint();
  const isSignedIn = props.clerkOn && (hinted || Boolean(props.signedIn));
  return <AuthControlsView {...props} isSignedIn={isSignedIn} />;
}

function AuthControlsView({
  clerkOn,
  demoMode,
  isSignedIn,
  variant,
  mobileVisible = false,
  primaryOnly = false,
  primaryLabel = "Get Started",
}: Props & { isSignedIn: boolean }) {
  const solid =
    variant === "header"
      ? solidClass
      : primaryOnly
        ? cn(ctaSolidClass, "px-8 py-4 text-base")
        : ctaSolidClass;
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
        {!primaryOnly && (
          <Link href={href} className={ghost}>
            Sign in
          </Link>
        )}
        <Link href={href} className={solid}>
          {primaryLabel}
        </Link>
      </div>
    );
  }

  if (isSignedIn) {
    return (
      <div className={wrapClass}>
        <Link href="/dashboard" className={solid}>
          Open app
        </Link>
      </div>
    );
  }

  return (
    <div className={wrapClass}>
      {!primaryOnly && (
        <Link href="/sign-in" className={ghost}>
          Sign in
        </Link>
      )}
      <Link href="/sign-up" className={solid}>
        {primaryLabel}
      </Link>
    </div>
  );
}
