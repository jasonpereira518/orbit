"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { OrbitLogo } from "@/components/orbit-logo";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Stagger, StaggerItem } from "@/components/onboarding/onboarding-ui";
import type { OnboardingPath } from "@/lib/onboarding-steps";
import { cn } from "@/lib/utils";

const TOUR_SETS_UP = [
  "Your AI key, checked as you save it",
  "Your LinkedIn export, started now so it’s ready tomorrow",
  "Google or Microsoft contacts, when your plan includes sync",
  "Every page, with six example people already in place",
];

/**
 * The first screen: the mark, one sentence, consent when Clerk did not record one, and the
 * choice of path. The guided tour is the primary card on purpose — it is the one that
 * teaches the real pages — and quick setup is the honest short route beside it.
 */
export function WelcomeStep({
  needsTerms,
  pending,
  onChoose,
}: {
  needsTerms: boolean;
  pending: boolean;
  onChoose: (path: OnboardingPath) => void;
}) {
  const [agreed, setAgreed] = useState(false);
  const blocked = pending || (needsTerms && !agreed);

  return (
    <Stagger className="mx-auto flex max-w-3xl flex-col items-center text-center">
      <StaggerItem className="relative mb-3 flex size-16 items-center justify-center">
        {/* The mark sits inside its own orbit: a ring with one moon, turning slowly. Linear,
            because an orbit that eases reads as a wobble; the global reduced-motion clamp
            stops it. */}
        <span aria-hidden className="absolute inset-0 rounded-full border border-primary/15" />
        <span
          aria-hidden
          className="absolute inset-0 animate-[interest-orbit_16s_linear_infinite] rounded-full"
        >
          <span className="absolute -top-1 left-1/2 size-2 -translate-x-1/2 rounded-full bg-primary shadow-[0_0_12px_2px] shadow-primary/40" />
        </span>
        <span aria-hidden className="absolute inset-3 rounded-full border border-dashed border-primary/10" />
        <OrbitLogo size="lg" priority />
      </StaggerItem>

      <StaggerItem>
        <h1 className="font-[family-name:var(--font-display)] text-4xl tracking-tight text-ink text-balance sm:text-5xl">
          Welcome to Orbit
        </h1>
      </StaggerItem>
      <StaggerItem>
        <p className="mt-2 max-w-md text-base text-muted-foreground text-pretty">
          Orbit remembers the people you meet and tells you when to reach back out. Choose how
          you’d like to start.
        </p>
      </StaggerItem>

      {needsTerms && (
        <StaggerItem className="mt-4 w-full max-w-lg">
          <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-border/70 bg-card/70 px-3 py-2.5 text-left text-sm text-muted-foreground">
            <Checkbox
              checked={agreed}
              onCheckedChange={(checked) => setAgreed(checked === true)}
              aria-label="I agree to the Terms of Service and Privacy Policy"
              className="mt-0.5"
            />
            <span>
              I agree to Orbit’s{" "}
              <Link href="/terms" target="_blank" className="text-primary underline-offset-4 hover:underline">
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link href="/privacy" target="_blank" className="text-primary underline-offset-4 hover:underline">
                Privacy Policy
              </Link>
              .
            </span>
          </label>
        </StaggerItem>
      )}

      <Stagger as="ul" className="mt-6 grid w-full gap-3 text-left sm:grid-cols-[1.15fr_1fr]">
        <StaggerItem as="li">
          <PathCard
            primary
            eyebrow="Recommended"
            title="Guided tour"
            time="A few setup steps, then a three-minute tour of the real pages."
            action="Start the tour"
            disabled={blocked}
            onClick={() => onChoose("tour")}
          >
            <ul className="space-y-1.5">
              {TOUR_SETS_UP.map((line) => (
                <li key={line} className="flex items-start gap-2 text-sm text-foreground">
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                  <span className="min-w-0">{line}</span>
                </li>
              ))}
            </ul>
          </PathCard>
        </StaggerItem>
        <StaggerItem as="li">
          <PathCard
            title="Quick setup"
            time="About a minute."
            action="Set up quickly"
            disabled={blocked}
            onClick={() => onChoose("quick")}
          >
            <p className="text-sm text-muted-foreground">
              Just the essentials and a quick look at what Orbit can do. The tour is always in
              Settings → Help if you want it later.
            </p>
          </PathCard>
        </StaggerItem>
      </Stagger>
    </Stagger>
  );
}

function PathCard({
  primary,
  eyebrow,
  title,
  time,
  action,
  disabled,
  onClick,
  children,
}: {
  primary?: boolean;
  eyebrow?: string;
  title: string;
  time: string;
  action: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex h-full flex-col gap-3 rounded-3xl border p-5",
        primary
          ? "border-primary/40 bg-card shadow-[0_18px_50px_-30px] shadow-primary/40"
          : "border-border/70 bg-card/60",
      )}
    >
      <div className="space-y-1">
        {eyebrow && (
          <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
            {eyebrow}
          </span>
        )}
        <h2 className="font-[family-name:var(--font-display)] text-2xl tracking-tight text-ink">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{time}</p>
      </div>
      <div className="flex-1">{children}</div>
      <Button
        type="button"
        size="lg"
        variant={primary ? "default" : "outline"}
        className="h-10 w-full text-[15px]"
        disabled={disabled}
        onClick={onClick}
      >
        {action}
        <ArrowRight className="size-4" aria-hidden />
      </Button>
    </div>
  );
}
