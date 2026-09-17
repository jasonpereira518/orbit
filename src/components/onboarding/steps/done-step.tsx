"use client";

import { ArrowRight, Check, FileArchive } from "lucide-react";
import { OrbitLogo } from "@/components/orbit-logo";
import { Button } from "@/components/ui/button";
import { Stagger, StaggerItem } from "@/components/onboarding/onboarding-ui";

export type SetupResult =
  | { kind: "manual" }
  | { kind: "capture"; count: number }
  | { kind: "import" };

function describe(result: SetupResult) {
  switch (result.kind) {
    case "manual":
      return "Added a contact by hand";
    case "capture":
      return result.count === 1
        ? "Added 1 person from your notes"
        : `Added ${result.count} people from your notes`;
    case "import":
      // The import keeps running after onboarding moves on, so "started" is the honest word.
      return "Started your LinkedIn import";
  }
}

export function DoneStep({
  results,
  linkedinRequested,
  pending,
  onFinish,
  onAddMore,
}: {
  results: SetupResult[];
  linkedinRequested: boolean;
  pending: boolean;
  onFinish: () => void;
  onAddMore: () => void;
}) {
  const imported = results.some((r) => r.kind === "import");
  return (
    <Stagger className="mx-auto flex max-w-lg flex-col items-center text-center">
      <StaggerItem className="relative mb-7 flex size-32 items-center justify-center">
        {/* A radial gradient, not a blur: a blurred layer inside a translating parent re-rasters
            every frame of the entrance. */}
        <span
          aria-hidden
          className="absolute -inset-6 rounded-full bg-[radial-gradient(circle,color-mix(in_oklab,var(--primary)_16%,transparent)_0%,transparent_68%)]"
        />
        <span aria-hidden className="absolute inset-0 rounded-full border border-primary/20" />
        <span
          aria-hidden
          className="absolute inset-0 animate-[interest-orbit_9s_linear_infinite] rounded-full"
        >
          <span className="absolute -top-1 left-1/2 size-2 -translate-x-1/2 rounded-full bg-primary" />
          <span className="absolute -bottom-0.5 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-amber-400" />
        </span>
        <OrbitLogo size="xl" />
      </StaggerItem>

      <StaggerItem>
        <h1 className="font-[family-name:var(--font-display)] text-4xl tracking-tight text-ink sm:text-5xl">
          You’re in orbit
        </h1>
      </StaggerItem>
      <StaggerItem>
        <p className="mt-3 text-base text-muted-foreground">
          Your dashboard is ready. Here&apos;s where you left things.
        </p>
      </StaggerItem>

      <Stagger as="ul" className="mt-8 w-full space-y-2 text-left">
        {results.map((r, i) => (
          <StaggerItem
            as="li"
            key={i}
            className="flex items-center gap-3 rounded-2xl border border-border/60 bg-card px-4 py-3 text-sm text-ink"
          >
            <DoneMark />
            {describe(r)}
          </StaggerItem>
        ))}
        {!imported && (
          <StaggerItem
            as="li"
            className="flex items-center gap-3 rounded-2xl border border-border/60 bg-card px-4 py-3 text-sm"
          >
            {linkedinRequested ? (
              <>
                <DoneMark />
                <span className="text-ink">
                  LinkedIn export requested
                  <span className="block text-muted-foreground">
                    We&apos;ll check in tomorrow to help you find the email.
                  </span>
                </span>
              </>
            ) : (
              <>
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <FileArchive className="size-3.5" aria-hidden />
                </span>
                <span className="text-ink">
                  LinkedIn export not started
                  <span className="block text-muted-foreground">
                    Request it any time from Imports. It takes about a day.
                  </span>
                </span>
              </>
            )}
          </StaggerItem>
        )}
      </Stagger>

      <StaggerItem className="mt-8 flex flex-wrap items-center justify-center gap-2">
        <Button
          type="button"
          size="lg"
          className="h-11 min-w-48 px-5 text-[15px]"
          disabled={pending}
          onClick={onFinish}
        >
          {pending ? "Opening…" : "Go to your dashboard"}
          {!pending && <ArrowRight className="size-4" aria-hidden />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="lg"
          className="h-11 text-muted-foreground"
          disabled={pending}
          onClick={onAddMore}
        >
          Add more people
        </Button>
      </StaggerItem>
    </Stagger>
  );
}

function DoneMark() {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
      <Check className="size-3.5" strokeWidth={3} aria-hidden />
    </span>
  );
}
