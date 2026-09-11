"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { useClerkSessionHint } from "@/lib/clerk-session-hint";

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
  primaryLabel = "Get Started",
  signInAs = "button",
  note,
}: Props & { isSignedIn: boolean }) {
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
      <div className={wrapClass}>
        <Link href="/dashboard" className={solid}>
          Open app
        </Link>
      </div>
    );
  }

  return signedOut("/sign-in", "/sign-up");
}
