"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { getTriageCandidates } from "@/actions/contacts";
import {
  acceptTerms,
  completeOnboarding,
  saveOnboardingStep,
  startOnboardingPath,
} from "@/actions/onboarding";
import { OrbitLogo } from "@/components/orbit-logo";
import { Button } from "@/components/ui/button";
import { OnboardingProgress } from "@/components/onboarding/onboarding-progress";
import {
  BackButton,
  Stagger,
  StaggerItem,
  StepHeading,
} from "@/components/onboarding/onboarding-ui";
import { AiKeyStep } from "@/components/onboarding/steps/ai-key-step";
import { CaptureStep } from "@/components/onboarding/steps/capture-step";
import { ConnectStep } from "@/components/onboarding/steps/connect-step";
import { HighlightsStep, type PlanFlags } from "@/components/onboarding/steps/highlights-step";
import { ImportStep } from "@/components/onboarding/steps/import-step";
import { LaunchStep } from "@/components/onboarding/steps/launch-step";
import { LinkedInStep } from "@/components/onboarding/steps/linkedin-step";
import { ManualStep } from "@/components/onboarding/steps/manual-step";
import { PeopleStep } from "@/components/onboarding/steps/people-step";
import { TriageStep } from "@/components/onboarding/steps/triage-step";
import { WelcomeStep } from "@/components/onboarding/steps/welcome-step";
import { useImportJob } from "@/lib/import-job-runner";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { connectConfigured, type ConnectAccount, type ConnectProvider } from "@/lib/onboarding-connect";
import {
  isOnboardingPath,
  isOnboardingStep,
  mainLine,
  nextStep,
  prevStep,
  resumeStep,
  stageOf,
  stepDirection,
  type OnboardingPath,
  type OnboardingStep,
  type StepFacts,
} from "@/lib/onboarding-steps";

export type OnboardingFlowProps = {
  initialStepId: string | null;
  initialPath: string | null;
  /** Clerk recorded no consent for this account: the welcome shows the checkbox. */
  needsTerms: boolean;
  hasApiKey: boolean;
  linkedinRequested: boolean;
  linkedinImported: boolean;
  /** Surface keys hidden from this viewer; their overview chapters are skipped. */
  hidden: string[];
  /** Page keys behind the coming-soon screen for this viewer. */
  comingSoon: string[];
  canUseSync: boolean;
  connect: Record<ConnectProvider, ConnectAccount>;
  planFlags: PlanFlags;
};

/**
 * Each step gets its own history entry (same URL, this key in `history.state`), so the
 * browser's and the phone's Back gesture step back through setup instead of leaving it.
 * No URL is passed: Next's patched `pushState` only dispatches a router restore when given
 * one, and a restore can drop a server action in flight.
 */
const HISTORY_KEY = "orbitOnboardingStep";

/** One full screen of the quick path needs at least this many people to be worth asking about. */
const TRIAGE_MIN = 8;

/**
 * The first-run stage. Two paths share it: the guided tour (setup, then a handoff to the
 * coach rail over the real pages) and quick setup (setup, first people, the overview). It
 * replaced a 10-step auto-advancing tour and a separate setup wizard that most people never
 * reached.
 *
 * Steps slide in the direction of travel with `mode="popLayout"`, so the outgoing step
 * leaves while the next arrives rather than after it. The stage is the full viewport, not a
 * card that resizes between steps, so nothing reflows mid-transition.
 */
export function OnboardingFlow({
  initialStepId,
  initialPath,
  needsTerms,
  hasApiKey,
  linkedinRequested,
  linkedinImported,
  hidden,
  comingSoon,
  canUseSync,
  connect,
  planFlags,
}: OnboardingFlowProps) {
  const [pending, start] = useTransition();
  const [path, setPath] = useState<OnboardingPath | null>(() =>
    isOnboardingPath(initialPath) ? initialPath : null,
  );
  const [[step, direction], setPosition] = useState<[OnboardingStep, 1 | -1]>(() => [
    resumeStep(initialStepId, initialPath),
    1,
  ]);
  const [apiKey, setApiKey] = useState(hasApiKey);
  const [requested, setRequested] = useState(linkedinRequested);
  const [termsDone, setTermsDone] = useState(!needsTerms);
  // Where the import branch was entered from decides where Back and Continue go.
  const [importFrom, setImportFrom] = useState<"linkedin" | "people">("linkedin");
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const comingSoonSet = useMemo(() => new Set(comingSoon), [comingSoon]);
  const stageRef = useRef<HTMLDivElement>(null);
  // Travel distance for the step slide: zero for reduced motion. MotionConfig alone makes the
  // transform instant rather than absent, which snapped the OUTGOING step 40px sideways while
  // it was still visible. This is client-only (`ssr: false`), so the hook has no server lag.
  const travel = useReducedMotionConfig() ? 0 : 40;
  const slide = useMemo(() => ({ dir: direction, travel }), [direction, travel]);

  const facts: StepFacts = useMemo(
    () => ({ hasApiKey: apiKey, connectConfigured: connectConfigured(connect) }),
    [apiKey, connect],
  );

  // The stage's own entries, mirrored so an on-screen Back can be a real `history.back()`
  // when the entry behind is that step. Pushing instead would leave the browser's Back
  // pointing forward, at the step just left.
  const entries = useRef<{ list: OnboardingStep[]; at: number }>({ list: [step], at: 0 });
  const pushStepEntry = useCallback((next: OnboardingStep) => {
    const e = entries.current;
    if (e.list[e.at] === next) return;
    e.list = [...e.list.slice(0, e.at + 1), next];
    e.at = e.list.length - 1;
    window.history.pushState({ ...window.history.state, [HISTORY_KEY]: next }, "");
  }, []);

  const goTo = useCallback((next: OnboardingStep, fromHistory = false) => {
    if (!fromHistory) pushStepEntry(next);
    setPosition(([current]) => [next, stepDirection(current, next)]);
    if (window.scrollY > 0) window.scrollTo({ top: 0 });
    // Fire-and-forget: a failed save only costs resuming at the previous step after a
    // refresh, which is not worth blocking a transition the user already made.
    void saveOnboardingStep(next)
      .then((res) => {
        if (!res.ok) console.error(`Onboarding step "${next}" was rejected by the server.`);
      })
      .catch((err) => console.error(`Failed to persist onboarding step "${next}"`, err));
  }, [pushStepEntry]);

  /** An on-screen Back: the browser's own when the entry behind is that step. */
  const backTo = useCallback(
    (target: OnboardingStep) => {
      const e = entries.current;
      if (e.at > 0 && e.list[e.at - 1] === target) window.history.back();
      else goTo(target);
    },
    [goTo],
  );

  // Stamp the entry the stage loaded on, then follow Back and Forward between steps. An
  // entry without the key (another page's) is left to the browser.
  useEffect(() => {
    if (!isOnboardingStep(window.history.state?.[HISTORY_KEY])) {
      window.history.replaceState({ ...window.history.state, [HISTORY_KEY]: step }, "");
    }
    const onPop = (e: PopStateEvent) => {
      // The tour is being handed off: the stage is already behind the person server-side,
      // so stay put and let the launch finish.
      if (entries.current.list[entries.current.at] === "launch") {
        window.history.pushState({ ...window.history.state, [HISTORY_KEY]: "launch" }, "");
        return;
      }
      const target = (e.state as Record<string, unknown> | null)?.[HISTORY_KEY];
      if (typeof target !== "string" || !isOnboardingStep(target)) return;
      const mirror = entries.current;
      if (mirror.list[mirror.at - 1] === target) mirror.at -= 1;
      else if (mirror.list[mirror.at + 1] === target) mirror.at += 1;
      else entries.current = { list: [target], at: 0 };
      goTo(target, true);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // Mount only: `step` is the starting entry's, and later steps stamp their own entries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goTo]);

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

  /** Forward along the path's main line from `from`'s node, skipping what the facts skip. */
  const advance = useCallback(
    (from: OnboardingStep, override?: Partial<StepFacts>) => {
      if (!path) return goTo("welcome");
      const next = nextStep(from, path, { ...facts, ...override });
      if (next) goTo(next);
    },
    [facts, goTo, path],
  );
  const retreat = useCallback(
    (from: OnboardingStep) => {
      if (!path) return backTo("welcome");
      backTo(prevStep(from, path, facts) ?? "welcome");
    },
    [backTo, facts, path],
  );

  const choosePath = (chosen: OnboardingPath) =>
    start(async () => {
      if (!termsDone) {
        await acceptTerms();
        setTermsDone(true);
      }
      await startOnboardingPath(chosen);
      setPath(chosen);
      pushStepEntry("linkedin");
      setPosition(() => ["linkedin", 1]);
    });

  const leave = useCallback(
    (finished: boolean) => {
      start(async () => {
        const res = await completeOnboarding({ finished });
        // A full load, not `router.replace` + `refresh`: the action revalidates, and its
        // response landing after a client navigation can snap the router back here.
        window.location.replace(res.redirectTo);
      });
    },
    [],
  );

  // After the quick path adds people: rate a screenful if there is one, else the overview.
  // The import branch usually has produced nothing yet (the job runs in the background), so
  // it skips straight on — which is right, and avoids rating a list that is still arriving.
  const afterPeople = useCallback(() => {
    start(async () => {
      const candidates = await getTriageCandidates().catch(() => []);
      goTo(candidates.length >= TRIAGE_MIN ? "triage" : "overview");
    });
  }, [goTo]);

  const switchToTour = () =>
    start(async () => {
      await startOnboardingPath("tour");
      setPath("tour");
      goTo("launch");
    });

  const stages = path ? mainLine(path, facts) : [];
  const stage = path
    ? step === "import" && importFrom === "linkedin"
      ? "linkedin"
      : stageOf(step, path)
    : null;
  const showSkip = step !== "welcome" && step !== "launch";

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
        <div className="min-w-0">
          {path && stage && <OnboardingProgress stages={stages} stage={stage} />}
        </div>
        <div className="justify-self-end">
          {showSkip && (
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

      {/* The bare shell has no global progress bar, so an import started here reports on
          the stage itself until the person reaches the app. */}
      <StageJobLine />

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
                <WelcomeStep needsTerms={!termsDone} pending={pending} onChoose={choosePath} />
              </Centered>
            )}

            {step === "linkedin" && (
              <LinkedInStep
                alreadyRequested={requested}
                onRequested={() => setRequested(true)}
                onContinue={() => advance("linkedin")}
                onHaveExport={() => {
                  setImportFrom("linkedin");
                  goTo("import");
                }}
                onBack={() => retreat("linkedin")}
              />
            )}

            {step === "import" && (
              <BranchStep
                eyebrow="Your people"
                title="Upload your LinkedIn export"
                onBack={() => backTo(importFrom === "linkedin" ? "linkedin" : "people")}
              >
                <ImportStep
                  onContinue={(started) => {
                    if (importFrom === "linkedin") return advance("linkedin");
                    return started ? afterPeople() : goTo("people");
                  }}
                />
              </BranchStep>
            )}

            {step === "ai-key" && (
              <BranchStep
                eyebrow="Your AI"
                title="Add your AI key"
                onBack={() => retreat("ai-key")}
              >
                <AiKeyStep
                  onSaved={() => {
                    setApiKey(true);
                    advance("ai-key", { hasApiKey: true });
                  }}
                  onSkip={() => advance("ai-key")}
                />
              </BranchStep>
            )}

            {step === "connect" && (
              <ConnectStep
                canUseSync={canUseSync}
                initial={connect}
                onContinue={() => advance("connect")}
                onBack={() => retreat("connect")}
              />
            )}

            {step === "people" && (
              <PeopleStep
                onBack={() => retreat("people")}
                onLater={() => goTo("overview")}
                onChoose={(choice) => {
                  if (choice === "import") setImportFrom("people");
                  goTo(choice);
                }}
              />
            )}

            {step === "capture" && (
              <BranchStep
                eyebrow="Your people"
                title="Capture from notes"
                description="Paste anything: meeting notes, a list of names, a brain dump after an event."
                onBack={() => backTo("people")}
              >
                <CaptureStep hasApiKey={apiKey} onSaved={afterPeople} />
              </BranchStep>
            )}

            {step === "manual" && (
              <BranchStep
                eyebrow="Your people"
                title="Add someone by hand"
                onBack={() => backTo("people")}
              >
                <ManualStep onCreated={afterPeople} />
              </BranchStep>
            )}

            {step === "triage" && (
              <BranchStep
                eyebrow="Almost done"
                title="How close are you?"
                description="A quick rating tells Orbit who matters most, so your follow-ups start in the right place."
              >
                <TriageStep onDone={() => goTo("overview")} />
              </BranchStep>
            )}

            {step === "overview" && (
              <HighlightsStep
                hidden={hiddenSet}
                comingSoon={comingSoonSet}
                planFlags={planFlags}
                facts={{ hasApiKey: apiKey, linkedinPending: requested && !linkedinImported }}
                onBack={() => retreat("overview")}
                onDone={() => leave(true)}
                onTour={switchToTour}
              />
            )}

            {step === "launch" && (
              <Centered>
                <LaunchStep />
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

function StageJobLine() {
  const job = useImportJob();
  if (!job || job.status !== "running") return null;
  const total = job.progress?.total ?? 0;
  const done = job.progress?.done ?? 0;
  return (
    <p
      role="status"
      className="relative z-10 mx-auto mt-3 w-full max-w-6xl px-4 text-xs text-muted-foreground sm:px-8"
    >
      Importing{total > 0 ? ` ${done} of ${total}` : ""}… it keeps going if you move on.
    </p>
  );
}

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
