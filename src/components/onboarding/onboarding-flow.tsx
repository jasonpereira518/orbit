"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  Sparkles,
  Upload,
  UserPlus,
} from "lucide-react";
import { completeOnboarding, saveOnboardingStep, skipOnboarding } from "@/actions/onboarding";
import { TourSidebar } from "@/components/onboarding/tour-sidebar";
import { TourCursor } from "@/components/onboarding/tour-cursor";
import {
  TOUR_INTERVAL_MS,
  TOUR_STEPS,
  type PreviewComponent,
  type TourNavKey,
} from "@/components/onboarding/tour-config";
import { usePrefersReducedMotion } from "@/components/onboarding/use-prefers-reduced-motion";
import { WelcomePreview } from "@/components/onboarding/previews/welcome-preview";
import { ContactsPreview } from "@/components/onboarding/previews/contacts-preview";
import { CapturePreview } from "@/components/onboarding/previews/capture-preview";
import { ImportsPreview } from "@/components/onboarding/previews/imports-preview";
import { RemindersPreview } from "@/components/onboarding/previews/reminders-preview";
import { ChatPreview } from "@/components/onboarding/previews/chat-preview";
import { GraphPreview } from "@/components/onboarding/previews/graph-preview";
import { DashboardPreview } from "@/components/onboarding/previews/dashboard-preview";
import { RecruitersPreview } from "@/components/onboarding/previews/recruiters-preview";
import { OutreachPreview } from "@/components/onboarding/previews/outreach-preview";
import { Button } from "@/components/ui/button";
import { OrbitLogo } from "@/components/orbit-logo";
import { cn } from "@/lib/utils";

const paths = [
  {
    href: "/contacts/new",
    icon: UserPlus,
    title: "Add someone manually",
    description: "Enter a name, company, and how you know them.",
    hotspot: "path-manual",
  },
  {
    href: "/capture",
    icon: Sparkles,
    title: "Capture from notes",
    description: "Paste meeting notes — AI extracts people and context.",
    hotspot: "path-capture",
  },
  {
    href: "/imports",
    icon: Upload,
    title: "Import LinkedIn",
    description: "Bring in connections, messages, or calendar meetings.",
    hotspot: "path-import",
  },
] as const;

const PREVIEWS: Record<Exclude<TourNavKey, "start">, PreviewComponent> = {
  welcome: WelcomePreview,
  dashboard: DashboardPreview,
  contacts: ContactsPreview,
  recruiters: RecruitersPreview,
  capture: CapturePreview,
  imports: ImportsPreview,
  reminders: RemindersPreview,
  chat: ChatPreview,
  graph: GraphPreview,
  outreach: OutreachPreview,
};

const START_INDEX = TOUR_STEPS.length - 1;

function indexForStep(stepId: string | null | undefined) {
  if (!stepId) return 0;
  const idx = TOUR_STEPS.findIndex((s) => s.id === stepId);
  return idx >= 0 ? idx : 0;
}

export function OnboardingFlow({
  initialStepId = null,
}: {
  initialStepId?: string | null;
}) {
  const router = useRouter();
  const reducedMotion = usePrefersReducedMotion();
  const previewRef = useRef<HTMLDivElement>(null);
  const [stepIndex, setStepIndex] = useState(() => indexForStep(initialStepId));
  const [playing, setPlaying] = useState(() => {
    const idx = indexForStep(initialStepId);
    return idx !== START_INDEX;
  });
  const [progress, setProgress] = useState(0);
  const [pending, start] = useTransition();

  const finishOnboarding = useCallback(
    (href: string) => {
      start(async () => {
        const res = await completeOnboarding(href);
        router.replace(res.redirectTo);
        router.refresh();
      });
    },
    [router]
  );

  const finishSkip = useCallback(() => {
    start(async () => {
      const res = await skipOnboarding();
      router.replace(res.redirectTo);
      router.refresh();
    });
  }, [router]);

  const step = TOUR_STEPS[stepIndex]!;
  const isStart = Boolean(step.isStart);
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === START_INDEX;
  const autoAdvance = playing && !isStart && !reducedMotion;
  const hotspots = step.hotspots ?? [];
  const showCursor = !reducedMotion && hotspots.length > 0;
  const tourStepCount = START_INDEX;

  const goTo = useCallback((index: number) => {
    const next = Math.max(0, Math.min(START_INDEX, index));
    setStepIndex(next);
    setProgress(0);
    if (next === START_INDEX) {
      setPlaying(false);
    }
    const nextStep = TOUR_STEPS[next];
    if (nextStep) {
      void saveOnboardingStep(nextStep.id);
    }
  }, []);

  const goNext = useCallback(() => {
    if (stepIndex < START_INDEX) goTo(stepIndex + 1);
  }, [goTo, stepIndex]);

  const goBack = useCallback(() => {
    if (stepIndex > 0) {
      setPlaying(true);
      goTo(stepIndex - 1);
    }
  }, [goTo, stepIndex]);

  // Auto-advance with freezable progress
  useEffect(() => {
    if (!autoAdvance) return;

    const startedAt = performance.now() - progress * TOUR_INTERVAL_MS;
    let raf = 0;

    const tick = (now: number) => {
      const next = Math.min(1, (now - startedAt) / TOUR_INTERVAL_MS);
      setProgress(next);
      if (next >= 1) {
        goNext();
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resume from frozen `progress` only when autoAdvance flips on
  }, [autoAdvance, goNext, stepIndex]);

  // Keyboard: ←/→, Space = pause/play
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goBack();
      } else if (e.key === " " || e.code === "Space") {
        if (isStart) return;
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goBack, goNext, isStart]);

  const Preview = !isStart
    ? PREVIEWS[step.id as Exclude<TourNavKey, "start">]
    : null;

  return (
    <div className="relative mx-auto flex min-h-screen max-w-5xl flex-col justify-center gap-5 px-4 py-8 sm:px-6">
      <header className="flex items-center justify-between gap-3 sm:hidden">
        <div className="flex items-center gap-2.5">
          <OrbitLogo size="sm" />
          <div>
            <p className="font-[family-name:var(--font-display)] text-sm leading-none text-primary">
              Orbit
            </p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              Getting started
            </p>
          </div>
        </div>
        <p className="text-[11px] tabular-nums text-muted-foreground">
          {isStart ? "Ready" : `${stepIndex + 1}/${tourStepCount}`}
        </p>
      </header>

      <div className="flex gap-5">
        <TourSidebar
          activeKey={step.navKey}
          reducedMotion={reducedMotion}
        />

        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="overflow-hidden rounded-[1.35rem] border border-border/70 bg-card/90 shadow-[0_20px_50px_-28px_rgba(15,61,62,0.35)] backdrop-blur-sm dark:shadow-[0_20px_50px_-28px_rgba(0,0,0,0.55)]">
            <div className="border-b border-border/60 px-5 py-5 sm:px-6">
              <div className="flex items-start justify-between gap-3">
                <p
                  className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                  aria-live="polite"
                >
                  {isStart
                    ? "Get started"
                    : `Step ${stepIndex + 1} of ${tourStepCount}`}
                </p>
                {!isStart && (
                  <p className="hidden text-[11px] text-muted-foreground sm:block">
                    {Math.round((stepIndex / tourStepCount) * 100)}% through
                  </p>
                )}
              </div>
              <h1
                className="mt-1.5 font-[family-name:var(--font-display)] text-2xl tracking-tight text-primary sm:text-3xl"
                aria-live="polite"
              >
                {step.title}
              </h1>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
                {step.body}
              </p>
            </div>

            <div
              ref={previewRef}
              className="relative min-h-[280px] bg-[radial-gradient(ellipse_at_top,color-mix(in_oklab,var(--primary)_6%,transparent),transparent_55%)] p-4 sm:min-h-[300px] sm:p-6"
            >
              <AnimatePresence mode="wait">
                {isStart ? (
                  <motion.div
                    key="start"
                    initial={reducedMotion ? false : { opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reducedMotion ? undefined : { opacity: 0, y: -8 }}
                    transition={{ duration: reducedMotion ? 0 : 0.3 }}
                  >
                    <StartStep
                      pending={pending}
                      onChoosePath={finishOnboarding}
                      onSkip={finishSkip}
                    />
                  </motion.div>
                ) : Preview ? (
                  <motion.div
                    key={step.id}
                    initial={reducedMotion ? false : { opacity: 0, y: 14 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reducedMotion ? undefined : { opacity: 0, y: -10 }}
                    transition={{ duration: reducedMotion ? 0 : 0.35 }}
                  >
                    <Preview reducedMotion={reducedMotion} />
                  </motion.div>
                ) : null}
              </AnimatePresence>

              {showCursor && (
                <TourCursor
                  key={step.id}
                  stepKey={step.id}
                  containerRef={previewRef}
                  hotspots={hotspots}
                  progress={progress}
                  playing={isStart ? true : playing}
                  reducedMotion={reducedMotion}
                  freeCycle={isStart}
                />
              )}
            </div>

            {!isStart && (
              <div className="h-1 w-full bg-muted/80">
                <div
                  className="h-full bg-primary transition-none"
                  style={{
                    width: `${(reducedMotion ? 0 : progress) * 100}%`,
                  }}
                />
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              {TOUR_STEPS.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  aria-label={`Go to ${s.title}`}
                  aria-current={i === stepIndex ? "step" : undefined}
                  onClick={() => {
                    if (i === START_INDEX) setPlaying(false);
                    else setPlaying(true);
                    goTo(i);
                  }}
                  className={cn(
                    "h-1.5 rounded-full transition-all",
                    i === stepIndex
                      ? "w-6 bg-primary"
                      : i < stepIndex
                        ? "w-1.5 bg-primary/45 hover:bg-primary/70"
                        : "w-1.5 bg-muted-foreground/30 hover:bg-muted-foreground/55"
                  )}
                />
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {!isStart && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  className="text-muted-foreground"
                  onClick={finishSkip}
                >
                  Skip tour
                </Button>
              )}

              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isFirst || pending}
                onClick={goBack}
                aria-label="Previous step"
              >
                <ChevronLeft className="h-4 w-4" />
                Back
              </Button>

              {!isStart && !reducedMotion && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => setPlaying((p) => !p)}
                  aria-label={playing ? "Pause tour" : "Play tour"}
                >
                  {playing ? (
                    <Pause className="h-4 w-4" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  {playing ? "Pause" : "Play"}
                </Button>
              )}

              {!isLast && (
                <Button
                  type="button"
                  size="sm"
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                  disabled={pending}
                  onClick={goNext}
                  aria-label="Next step"
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>

          <p className="text-center text-[11px] text-muted-foreground sm:text-left">
            {isStart
              ? "You only see this once when you set up your account."
              : reducedMotion
                ? "Use Next / Back to move through the tour."
                : "Auto-advances — pause anytime, or use arrow keys and space."}
          </p>
        </div>
      </div>
    </div>
  );
}

function StartStep({
  pending,
  onChoosePath,
  onSkip,
}: {
  pending: boolean;
  onChoosePath: (href: string) => void;
  onSkip: () => void;
}) {
  return (
    <div className="space-y-4">
      <ul className="space-y-3">
        {paths.map((path, i) => {
          const Icon = path.icon;
          return (
            <li key={path.href}>
              <motion.button
                type="button"
                disabled={pending}
                data-tour-hotspot={path.hotspot}
                onClick={() => onChoosePath(path.href)}
                initial={false}
                whileHover={pending ? undefined : { y: -1 }}
                transition={{ type: "spring", stiffness: 400, damping: 28 }}
                className={cn(
                  "group flex w-full items-start gap-4 rounded-2xl border border-border/70 bg-background/80 p-5 text-left transition-colors",
                  "hover:border-primary/30 hover:bg-accent",
                  "disabled:pointer-events-none disabled:opacity-60",
                  i === 0 && "ring-1 ring-primary/10"
                )}
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                  <Icon className="h-5 w-5" />
                </span>
                <span>
                  <span className="block font-medium text-primary">
                    {path.title}
                  </span>
                  <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
                    {path.description}
                  </span>
                </span>
              </motion.button>
            </li>
          );
        })}
      </ul>

      <div className="flex justify-start pt-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          className="text-muted-foreground"
          onClick={onSkip}
        >
          Skip for now
        </Button>
      </div>
    </div>
  );
}
