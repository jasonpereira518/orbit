"use client";

import Link from "next/link";
import { SignInButton, SignUpButton, Show, UserButton } from "@clerk/nextjs";
import { clerkAppearance } from "@/lib/clerk-appearance";

const ghostClass =
  "rounded-lg px-3 py-2 text-sm text-[#c5d4d1] transition-colors hover:text-white";
const solidClass =
  "rounded-lg bg-[#e8f3f1] px-3.5 py-2 text-sm font-medium text-[#0f3d3e] transition-colors hover:bg-white";
const ctaSolidClass =
  "inline-flex items-center justify-center rounded-lg bg-[#e8f3f1] px-6 py-3 text-sm font-medium text-[#0f3d3e] transition-colors hover:bg-white";
const ctaGhostClass =
  "inline-flex items-center justify-center rounded-lg border border-white/20 bg-white/5 px-6 py-3 text-sm text-[#e8f3f1] transition-colors hover:border-white/35 hover:bg-white/10";

export function LandingAuthControls({
  clerkOn,
  demoMode,
  variant,
}: {
  clerkOn: boolean;
  demoMode: boolean;
  variant: "header" | "hero";
}) {
  const primaryHref = clerkOn ? "/sign-up" : demoMode ? "/dashboard" : "/sign-in";
  const secondaryHref = clerkOn ? "/sign-in" : demoMode ? "/dashboard" : "/sign-in";
  const solid = variant === "header" ? solidClass : ctaSolidClass;
  const ghost = variant === "header" ? ghostClass : ctaGhostClass;

  if (!clerkOn) {
    return (
      <div
        className={
          variant === "hero"
            ? "flex w-full flex-col gap-3 sm:w-auto sm:flex-row"
            : "flex items-center gap-2 sm:gap-3"
        }
      >
        <Link href={secondaryHref} className={ghost}>
          Sign in
        </Link>
        <Link href={primaryHref} className={solid}>
          Get started
        </Link>
      </div>
    );
  }

  return (
    <div
      className={
        variant === "hero"
          ? "flex w-full flex-col gap-3 sm:w-auto sm:flex-row"
          : "flex items-center gap-2 sm:gap-3"
      }
    >
      <Show when="signed-out">
        <SignInButton mode="redirect" forceRedirectUrl="/dashboard">
          <button type="button" className={ghost}>
            Sign in
          </button>
        </SignInButton>
        <SignUpButton mode="redirect" forceRedirectUrl="/onboarding">
          <button type="button" className={solid}>
            Get started
          </button>
        </SignUpButton>
      </Show>
      <Show when="signed-in">
        <Link href="/dashboard" className={solid}>
          Open app
        </Link>
        <UserButton appearance={clerkAppearance} />
      </Show>
    </div>
  );
}
