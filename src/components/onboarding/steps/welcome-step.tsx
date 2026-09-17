"use client";

import { ArrowRight, FileArchive, Sparkles, UserPlus } from "lucide-react";
import { OrbitLogo } from "@/components/orbit-logo";
import { Button } from "@/components/ui/button";
import { Stagger, StaggerItem } from "@/components/onboarding/onboarding-ui";

const PLAN = [
  {
    icon: FileArchive,
    title: "Start your LinkedIn export",
    body: "It takes LinkedIn up to a day, so it goes first.",
  },
  {
    icon: Sparkles,
    title: "See what Orbit can do",
    body: "A quick look around while LinkedIn works.",
  },
  {
    icon: UserPlus,
    title: "Add your first people",
    body: "From notes, by hand, or from an export you already have.",
  },
];

export function WelcomeStep({ onStart }: { onStart: () => void }) {
  return (
    <Stagger className="mx-auto flex max-w-xl flex-col items-center text-center">
      <StaggerItem className="relative mb-8 flex size-36 items-center justify-center">
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
        <span aria-hidden className="absolute inset-5 rounded-full border border-dashed border-primary/10" />
        <OrbitLogo size="xl" priority />
      </StaggerItem>

      <StaggerItem>
        <h1 className="font-[family-name:var(--font-display)] text-4xl tracking-tight text-ink text-balance sm:text-5xl">
          Welcome to Orbit
        </h1>
      </StaggerItem>
      <StaggerItem>
        <p className="mt-3 max-w-md text-base text-muted-foreground text-pretty">
          Orbit remembers the people you meet and tells you when to reach back out. Setup takes
          about three minutes.
        </p>
      </StaggerItem>

      <Stagger as="ol" className="mt-8 w-full space-y-2 text-left">
        {PLAN.map((item, i) => {
          const Icon = item.icon;
          return (
            <StaggerItem
              as="li"
              key={item.title}
              className="flex items-center gap-4 rounded-2xl border border-border/60 bg-card/70 px-4 py-3"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-primary">
                <Icon className="size-5" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink">
                  <span className="sr-only">Step {i + 1}: </span>
                  {item.title}
                </span>
                <span className="block text-sm text-muted-foreground">{item.body}</span>
              </span>
            </StaggerItem>
          );
        })}
      </Stagger>

      <StaggerItem className="mt-8">
        <Button type="button" size="lg" onClick={onStart} className="h-11 min-w-44 px-5 text-[15px]">
          Let’s start
          <ArrowRight className="size-4" aria-hidden />
        </Button>
      </StaggerItem>
    </Stagger>
  );
}
