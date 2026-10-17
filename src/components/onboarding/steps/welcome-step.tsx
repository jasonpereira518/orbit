"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { OrbitLogo } from "@/components/orbit-logo";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Stagger, StaggerItem } from "@/components/onboarding/onboarding-ui";
import { FREE_STARTER_CREDITS, PLAN_CONFIG } from "@/lib/plans/plan-config";

/**
 * The first screen: the mark, one sentence, consent when Clerk did not record one, and one
 * thing to do — add someone you met. A real person with a follow-up is what Orbit is for, so
 * it is the default, a screen away. The guided tour (six example people across every page) is
 * still one click, for anyone who would rather look first; so is skipping.
 *
 * It replaced a choice of two equal cards with the tour recommended, which ended most first
 * sessions with no real person in them at all.
 */
export function WelcomeStep({
  needsTerms,
  pending,
  showCredits,
  onStart,
  onTour,
  onSkip,
}: {
  needsTerms: boolean;
  pending: boolean;
  /** A Free account on Orbit's included AI: say what it starts with and what adding someone costs. */
  showCredits: boolean;
  onStart: () => void;
  onTour: () => void;
  onSkip: () => void;
}) {
  const [agreed, setAgreed] = useState(false);
  const blocked = pending || (needsTerms && !agreed);

  return (
    <Stagger className="mx-auto flex max-w-xl flex-col items-center text-center">
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
          Orbit remembers the people you meet and tells you when to reach back out. Start with one
          person you met recently — it takes about a minute.
        </p>
      </StaggerItem>

      {needsTerms && (
        <StaggerItem className="mt-4 w-full max-w-md">
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

      <StaggerItem className="mt-6 w-full max-w-md">
        <Button
          type="button"
          size="lg"
          className="h-11 w-full text-[15px]"
          disabled={blocked}
          onClick={onStart}
        >
          Add someone you met
          <ArrowRight className="size-4" aria-hidden />
        </Button>
        {showCredits && (
          <p className="mt-2 text-xs text-muted-foreground">
            Free includes {PLAN_CONFIG.free.monthlyCredits} AI credits a month plus {FREE_STARTER_CREDITS} to start.
            Adding someone uses about one
          </p>
        )}
      </StaggerItem>

      <StaggerItem className="mt-5 flex flex-col items-center gap-1 text-sm">
        <Button type="button" variant="link" className="h-auto p-1 text-primary" disabled={blocked} onClick={onTour}>
          Show me around with example people first
        </Button>
        <Button
          type="button"
          variant="link"
          className="h-auto p-1 font-normal text-muted-foreground"
          disabled={blocked}
          onClick={onSkip}
        >
          Skip for now
        </Button>
      </StaggerItem>
    </Stagger>
  );
}
