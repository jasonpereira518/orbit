"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { completeOnboarding, saveOnboardingStep } from "@/actions/onboarding";
import { OrbitLogo } from "@/components/orbit-logo";
import { Button } from "@/components/ui/button";
import { OnboardingProgress } from "@/components/onboarding/onboarding-progress";
import {
  BackButton,
  Stagger,
  StaggerItem,
  StepHeading,
} from "@/components/onboarding/onboarding-ui";
import { WelcomeStep } from "@/components/onboarding/steps/welcome-step";
import { LinkedInStep } from "@/components/onboarding/steps/linkedin-step";
import { HighlightsStep, type PlanFlags } from "@/components/onboarding/steps/highlights-step";
import { PeopleStep } from "@/components/onboarding/steps/people-step";
import { DoneStep, type SetupResult } from "@/components/onboarding/steps/done-step";
import { WizardAiKey } from "@/components/onboarding/wizard/wizard-ai-key";
import { WizardAddManual } from "@/components/onboarding/wizard/wizard-add-manual";
import { WizardCapture } from "@/components/onboarding/wizard/wizard-capture";
import { WizardImport } from "@/components/onboarding/wizard/wizard-import";
import { WizardTriage } from "@/components/onboarding/wizard/wizard-triage";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import {
  ONBOARDING_STEPS,
  resumeStep,
  stageOf,
  type OnboardingStep,
} from "@/lib/onboarding-steps";

export type OnboardingFlowProps = {
  initialStepId: string | null;
  hasApiKey: boolean;
  linkedinRequested: boolean;
  /** Surface keys hidden from this viewer; their highlight chapters are skipped. */
  hidden: string[];
  planFlags: PlanFlags;
};

/**
 * The first run, as one flow: welcome → LinkedIn export → what Orbit does → add people →
 * done. It replaced a 10-step auto-advancing tour and a separate setup wizard that most
 * people never reached.
 *
 * Steps slide in the direction of travel with `mode="popLayout"`, so the outgoing step
 * leaves while the next arrives rather than after it (the old `mode="wait"` spent ~0.7s of
 * dead air per step). The stage is the full viewport, not a card that resizes between
 * steps, so nothing reflows mid-transition.
 */
export function OnboardingFlow({
  initialStepId,
  hasApiKey,
  linkedinRequested,
  hidden,
  planFlags,
}: OnboardingFlowProps) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [[step, direction], setPosition] = useState<[OnboardingStep, 1 | -1]>(() => [
    resumeStep(initialStepId),
    1,
  ]);
  const [apiKey, setApiKey] = useState(hasApiKey);
  const [requested, setRequested] = useState(linkedinRequested);
  const [results, setResults] = useState<SetupResult[]>([]);
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const stageRef = useRef<HTMLDivElement>(null);
  // Travel distance for the step slide: zero for reduced motion. MotionConfig alone makes the
  // transform instant rather than absent, which snapped the OUTGOING step 40px sideways while
  // it was still visible. This is client-only (`ssr: false`), so the hook has no server lag.
  const travel = useReducedMotionConfig() ? 0 : 40;
  const slide = useMemo(() => ({ dir: direction, travel }), [direction, travel]);

  const goTo = useCallback((next: OnboardingStep) => {
    setPosition(([current]) => [
      next,
      ONBOARDING_STEPS.indexOf(next) >= ONBOARDING_STEPS.indexOf(current) ? 1 : -1,
    ]);
    if (window.scrollY > 0) window.scrollTo({ top: 0 });
    // Fire-and-forget: a failed save only costs resuming at the previous step after a
    // refresh, which is not worth blocking a transition the user already made.
    void saveOnboardingStep(next)
      .then((res) => {
        if (!res.ok) console.error(`Onboarding step "${next}" was rejected by the server.`);
      })
      .catch((err) => console.error(`Failed to persist onboarding step "${next}"`, err));
  }, []);

  // The control the user pressed has just been unmounted with the old step, which drops
  // focus to <body>. Hand it to the new step so keyboard and screen-reader users land at
  // its start instead of the top of the document.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) {
      stageRef.current?.focus({ preventScroll: true });
    }
  }, [step]);

  const addResult = useCallback((r: SetupResult) => setResults((all) => [...all, r]), []);

  const leave = useCallback(
    (finished: boolean) => {
      start(async () => {
        const res = await completeOnboarding({ finished });
        router.replace(res.redirectTo);
        router.refresh();
      });
    },
    [router],
  );

  const stage = stageOf(step);

  return (
    <div className="relative flex min-h-dvh flex-col overflow-x-clip">
      {/* A faint glow behind everything: static, so it costs nothing per frame. No ring —
          at this size its edge ran straight through the step content. */}
      <div
        aria-hidden
        className="pointer-events-none absolute top-[-30vmax] left-1/2 size-[80vmax] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,color-mix(in_oklab,var(--primary)_5%,transparent)_0%,transparent_60%)]"
      />

      <header className="relative z-10 mx-auto grid w-full max-w-6xl grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 pt-4 sm:px-8 sm:pt-6">
        <OrbitLogo size="sm" className="justify-self-start" />
        <OnboardingProgress stage={stage} />
        <div className="justify-self-end">
          {step !== "done" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              disabled={pending}
              onClick={() => leave(false)}
            >
              Skip setup
            </Button>
          )}
        </div>
      </header>

      <main className="relative mx-auto w-full max-w-6xl flex-1 px-4 pt-8 pb-16 sm:px-8 sm:pt-12">
        <AnimatePresence mode="popLayout" initial={false} custom={slide}>
          <motion.div
            key={step}
            ref={stageRef}
            tabIndex={-1}
            custom={slide}
            variants={STEP_MOTION}
            initial="enter"
            animate="center"
            exit="exit"
            className="w-full outline-none"
          >
            {step === "welcome" && (
              <Centered>
                <WelcomeStep onStart={() => goTo("linkedin")} />
              </Centered>
            )}

            {step === "linkedin" && (
              <LinkedInStep
                alreadyRequested={requested}
                onRequested={() => setRequested(true)}
                onContinue={() => goTo("highlights")}
                onHaveExport={() => goTo("import")}
                onBack={() => goTo("welcome")}
              />
            )}

            {step === "highlights" && (
              <HighlightsStep
                hidden={hiddenSet}
                planFlags={planFlags}
                onBack={() => goTo("linkedin")}
                onDone={() => goTo("add-people")}
              />
            )}

            {step === "add-people" && (
              <PeopleStep
                onBack={() => goTo("highlights")}
                onLater={() => goTo("done")}
                // Capture needs a working AI key; without one it would open on an error, so
                // detour through the key step first. Import and manual need no key.
                onChoose={(path) => goTo(path === "capture" && !apiKey ? "ai-key" : path)}
              />
            )}

            {step === "ai-key" && (
              <BranchStep
                eyebrow="Before you capture"
                title="Connect your AI key"
                onBack={() => goTo("add-people")}
              >
                <WizardAiKey
                  onSaved={() => {
                    setApiKey(true);
                    goTo("capture");
                  }}
                  onSkip={() => goTo("capture")}
                />
              </BranchStep>
            )}

            {step === "capture" && (
              <BranchStep
                eyebrow="Your people"
                title="Capture from notes"
                description="Paste anything: meeting notes, a list of names, a brain dump after an event."
                onBack={() => goTo("add-people")}
              >
                <WizardCapture
                  hasApiKey={apiKey}
                  onSaved={(count) => {
                    addResult({ kind: "capture", count });
                    goTo("triage");
                  }}
                />
              </BranchStep>
            )}

            {step === "manual" && (
              <BranchStep
                eyebrow="Your people"
                title="Add someone by hand"
                onBack={() => goTo("add-people")}
              >
                <WizardAddManual
                  onCreated={() => {
                    addResult({ kind: "manual" });
                    goTo("triage");
                  }}
                />
              </BranchStep>
            )}

            {step === "import" && (
              <BranchStep
                eyebrow="Your people"
                title="Upload your LinkedIn export"
                onBack={() => goTo("add-people")}
              >
                <WizardImport
                  onContinue={(started) => {
                    if (!started) return goTo("add-people");
                    addResult({ kind: "import" });
                    goTo("triage");
                  }}
                />
              </BranchStep>
            )}

            {step === "triage" && (
              <BranchStep
                eyebrow="Almost done"
                title="How close are you?"
                description="A quick rating tells Orbit who matters most, so your follow-ups start in the right place."
              >
                <WizardTriage onDone={() => goTo("done")} />
              </BranchStep>
            )}

            {step === "done" && (
              <Centered>
                <DoneStep
                  results={results}
                  linkedinRequested={requested}
                  pending={pending}
                  onFinish={() => leave(true)}
                  onAddMore={() => goTo("add-people")}
                />
              </Centered>
            )}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}

type Slide = { dir: 1 | -1; travel: number };

/**
 * Direction-aware: forward enters from the right and leaves to the left, Back reverses it.
 * With reduced motion `travel` is 0 and it is a plain crossfade. Leaving is quicker than
 * arriving, so the next step is already readable while the last one clears.
 */
const STEP_MOTION = {
  enter: ({ dir, travel }: Slide) => ({ opacity: 0, x: travel * dir }),
  center: { opacity: 1, x: 0, transition: { duration: DUR.slow, ease: EASE_HOUSE } },
  exit: ({ dir, travel }: Slide) => ({
    opacity: 0,
    x: -travel * dir,
    transition: { duration: DUR.base, ease: EASE_HOUSE },
  }),
};

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[calc(100dvh-12rem)] items-center justify-center">{children}</div>
  );
}

function BranchStep({
  eyebrow,
  title,
  description,
  onBack,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  onBack?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Stagger className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-4">
        {onBack && (
          <StaggerItem>
            <BackButton onClick={onBack} />
          </StaggerItem>
        )}
        <StepHeading eyebrow={eyebrow} title={title}>
          {description}
        </StepHeading>
      </div>
      <StaggerItem>{children}</StaggerItem>
    </Stagger>
  );
}
