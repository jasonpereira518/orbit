"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Clock } from "lucide-react";
import { OnboardingMark } from "@/components/onboarding/onboarding-mark";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Stagger, StaggerItem } from "@/components/onboarding/onboarding-ui";
import { useViewerPlan } from "@/components/viewer-plan";
import { FREE_STARTER_CREDITS } from "@/lib/plans/plan-config";

/**
 * The first screen: the mark, one sentence, consent when Clerk did not record one, and one
 * thing to do — add someone you met. A real person with a follow-up is what Orbit is for, so
 * it is the default, a screen away; About you follows the first win rather than standing in
 * front of it. The guided tour (six example people across every page) is still one click, for
 * anyone who would rather look first; so is skipping. Each route says how long it takes.
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
  // The live plan table, so the line follows what Free gets on this deployment today.
  const freeMonthly = useViewerPlan().planConfig.free.monthlyCredits;
  const blocked = pending || (needsTerms && !agreed);

  return (
    <Stagger className="mx-auto flex w-full max-w-xl flex-col items-center text-center">
      <StaggerItem className="mb-3">
        <OnboardingMark size={68} />
      </StaggerItem>

      <StaggerItem>
        <h1 className="font-[family-name:var(--font-display)] text-4xl tracking-tight text-ink text-balance sm:text-5xl">
          Welcome to Orbit
        </h1>
      </StaggerItem>
      <StaggerItem>
        <p className="mt-2 max-w-md text-sm text-muted-foreground text-pretty sm:text-[0.9375rem]">
          Orbit remembers the people you meet and tells you when to reach back out. Start with one
          person you met recently.
        </p>
      </StaggerItem>

      {needsTerms && (
        <StaggerItem className="mt-4 w-full max-w-lg">
          <label className="flex min-h-9 cursor-pointer items-center justify-center gap-2.5 text-left text-[0.8125rem] text-muted-foreground">
            <Checkbox
              checked={agreed}
              onCheckedChange={(checked) => setAgreed(checked === true)}
              aria-label="I agree to the Terms of Service and Privacy Policy"
            />
            <span>
              I agree to Orbit’s{" "}
              <Link href="/terms" target="_blank" className="text-primary underline underline-offset-4">
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link href="/privacy" target="_blank" className="text-primary underline underline-offset-4">
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
        <p className="mt-2 flex items-center justify-center gap-1.5 text-xs font-medium text-ink">
          <Clock className="size-3.5 text-gold" aria-hidden />
          About 2 minutes
        </p>
        {showCredits && freeMonthly ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Free includes {freeMonthly} AI credits a month plus {FREE_STARTER_CREDITS} to start.
            Adding someone uses about one
          </p>
        ) : null}
      </StaggerItem>


      <StaggerItem className="mt-5 flex flex-col items-center gap-1 text-sm">
        <Button type="button" variant="link" className="h-auto p-1 text-primary" disabled={blocked} onClick={onTour}>
          Show me around with example people first
        </Button>
        <span className="text-xs text-muted-foreground">About 5 minutes</span>
        <Button
          type="button"
          variant="link"
          className="mt-1 h-auto p-1 font-normal text-muted-foreground"
          disabled={blocked}
          onClick={onSkip}
        >
          Skip for now
        </Button>
      </StaggerItem>
    </Stagger>
  );
}
