"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { UserButton } from "@clerk/nextjs";
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
 * Auth state is resolved server-side (see (marketing)/page.tsx), so the
 * correct variant renders from the first frame — signed-out visitors get
 * real sign-in/sign-up links, signed-in users get "Open app". Only the
 * Clerk avatar menu waits for hydration, behind a fixed-size placeholder
 * so nothing shifts.
 */
export function LandingAuthControls({
  clerkOn,
  demoMode,
  signedIn = false,
  variant,
  mobileVisible = false,
}: {
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
}) {
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

  if (signedIn) {
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
