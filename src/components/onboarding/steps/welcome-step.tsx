"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Clock, Compass, Zap, type LucideIcon } from "lucide-react";
import { OnboardingMark } from "@/components/onboarding/onboarding-mark";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CARD,
  IconBadge,
  RecommendedTag,
  Stagger,
  StaggerItem,
} from "@/components/onboarding/onboarding-ui";
import type { OnboardingPath } from "@/lib/onboarding-steps";
import { cn } from "@/lib/utils";

/**
 * The first screen: the mark, one sentence, the choice of path, and consent when Clerk did not
 * record one. The guided tour is the primary card on purpose — it is the one that teaches the
 * real pages — and quick setup is the honest short route beside it. Each card says how long
 * it takes: the tour itself is three minutes, plus About you and accounts.
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
    <Stagger className="mx-auto flex w-full max-w-3xl flex-col items-center text-center">
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
          Orbit remembers the people you meet and tells you when to reach back out. Pick how you’d
          like to start.
        </p>
      </StaggerItem>

      <Stagger as="ul" className="mt-6 grid w-full gap-3 text-left sm:grid-cols-2">
        <StaggerItem as="li">
          <PathCard
            primary
            icon={Compass}
            title="Guided tour"
            body="About you, connect your accounts, then a three-minute tour of the real pages."
            time="About 5 minutes."
            action="Start the tour"
            disabled={blocked}
            onClick={() => onChoose("tour")}
          />
        </StaggerItem>
        <StaggerItem as="li">
          <PathCard
            icon={Zap}
            title="Quick setup"
            body="About you, your people, your accounts, then a quick look at what Orbit does."
            time="About 2 minutes."
            action="Set up quickly"
            disabled={blocked}
            onClick={() => onChoose("quick")}
          />
        </StaggerItem>
      </Stagger>

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
    </Stagger>
  );
}

function PathCard({
  primary,
  icon,
  title,
  body,
  time,
  action,
  disabled,
  onClick,
}: {
  primary?: boolean;
  icon: LucideIcon;
  title: string;
  body: string;
  time: string;
  action: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className={cn(
        CARD,
        "flex h-full flex-col gap-4 p-4 sm:p-5",
        primary && "border-primary shadow-[0_8px_20px_-10px] shadow-primary/30",
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <IconBadge icon={icon} tone={primary ? "teal" : "gold"} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            {primary && <RecommendedTag />}
          </div>
          <p className="text-[0.8125rem] leading-snug text-muted-foreground">{body}</p>
          <p className="flex items-center gap-1.5 text-xs font-medium text-ink">
            <Clock className="size-3.5 text-gold" aria-hidden />
            {time}
          </p>
        </div>
      </div>
      <Button
        type="button"
        size="lg"
        variant={primary ? "default" : "outline"}
        className="mt-auto h-10 w-full text-sm"
        disabled={disabled}
        onClick={onClick}
      >
        {action}
        <ArrowRight className="size-4" aria-hidden />
      </Button>
    </div>
  );
}
