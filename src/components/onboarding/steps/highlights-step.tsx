"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotionConfig, type PanInfo } from "motion/react";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  BackButton,
  ProTag,
  SoonTag,
  Stagger,
  StaggerItem,
  StepHeading,
} from "@/components/onboarding/onboarding-ui";
import {
  visibleChapters,
  type HighlightChapter,
  type PlanFlag,
} from "@/components/onboarding/highlights/chapters";
import { integrationHref } from "@/components/settings/sections";
import { DUR, EASE_HOUSE, SPRING_PILL } from "@/lib/motion";
import { cn } from "@/lib/utils";

export type PlanFlags = Record<PlanFlag, boolean>;

/** Live facts the overview tags each chapter with, so "Needs AI key" is true, not generic. */
export type OverviewFacts = {
  hasApiKey: boolean;
  /** A LinkedIn export was requested and nothing from it has been imported yet. */
  linkedinPending: boolean;
};

const SWIPE_DISTANCE = 60;
const SWIPE_VELOCITY = 400;

/**
 * Quick setup's overview: one chapter per thing Orbit does, self-paced on purpose (the old
 * tour advanced every seven seconds and took the choice of reading speed away). Each
 * chapter carries a live tag — Pro, Soon, Needs AI key, Upload when your export arrives —
 * computed from the account, never hard-coded.
 *
 * Chapter changes slide in the direction of travel. On a phone the preview is swipeable;
 * everywhere, ← and → move between chapters.
 */
export function HighlightsStep({
  hidden,
  comingSoon,
  planFlags,
  facts,
  onBack,
  onDone,
  onTour,
}: {
  hidden: ReadonlySet<string>;
  comingSoon: ReadonlySet<string>;
  planFlags: PlanFlags;
  facts: OverviewFacts;
  onBack: () => void;
  onDone: () => void;
  /** "Take the guided tour instead" — switches path from the last screen. */
  onTour?: () => void;
}) {
  const chapters = useMemo(() => visibleChapters(hidden), [hidden]);
  const [[index, direction], setPage] = useState<[number, 1 | -1]>([0, 1]);
  const last = chapters.length - 1;
  const chapter = chapters[Math.min(index, last)];
  // Swiping is for touch. With a mouse, a draggable card fights text selection and reads as
  // broken; the buttons and arrow keys cover it. Read once — this renders client-only.
  // Zero travel for reduced motion — see the same note in onboarding-flow.tsx.
  const travel = useReducedMotionConfig() ? 0 : 32;
  const slide = useMemo(() => ({ dir: direction, travel }), [direction, travel]);
  const [coarsePointer] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches,
  );

  const go = useCallback(
    (next: number) => {
      if (next < 0 || next > last) return;
      setPage(([current]) => [next, next > current ? 1 : -1]);
    },
    [last],
  );
  const next = useCallback(() => (index >= last ? onDone() : go(index + 1)), [go, index, last, onDone]);
  const prev = useCallback(() => go(index - 1), [go, index]);

  // ← / → between chapters, unless someone is typing (the feedback widget lives on this page).
  const nextRef = useRef(next);
  const prevRef = useRef(prev);
  useEffect(() => {
    nextRef.current = next;
    prevRef.current = prev;
  }, [next, prev]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, [contenteditable='true'], [role='dialog']")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        nextRef.current();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prevRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.x < -SWIPE_DISTANCE || info.velocity.x < -SWIPE_VELOCITY) next();
    else if (info.offset.x > SWIPE_DISTANCE || info.velocity.x > SWIPE_VELOCITY) prev();
  };

  if (!chapter) {
    // Every chapter hidden by an operator — nothing to show, so do not strand the user.
    return (
      <div className="mx-auto max-w-xl space-y-6">
        <BackButton onClick={onBack} />
        <Button type="button" onClick={onDone}>
          Go to dashboard
          <ArrowRight className="size-4" aria-hidden />
        </Button>
      </div>
    );
  }

  return (
    <Stagger className="space-y-5">
      <div className="space-y-3">
        <StaggerItem>
          <BackButton onClick={onBack} />
        </StaggerItem>
        <StepHeading eyebrow="You’re set up" title="Here’s what Orbit can do">
          Everything here is one click from the sidebar. The tags show what needs a key, an import,
          or a plan upgrade.
        </StepHeading>
      </div>

      <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10">
        {/* min-w-0: on a phone the rail is one nowrap strip, and a grid item's default
            min-width is its content — without this the strip widened the whole column and
            pushed Next off the right edge of the screen. */}
        <StaggerItem className="min-w-0">
          <ChapterRail
            chapters={chapters}
            index={index}
            planFlags={planFlags}
            comingSoon={comingSoon}
            onSelect={go}
          />
        </StaggerItem>

        <StaggerItem className="min-w-0">
          <section
            aria-roledescription="carousel"
            aria-label="Orbit features"
            className="relative overflow-hidden rounded-3xl border border-border/60 bg-card/60"
          >
            <AnimatePresence mode="popLayout" initial={false} custom={slide}>
              <motion.div
                key={chapter.id}
                custom={slide}
                variants={SLIDE}
                initial="enter"
                animate="center"
                exit="exit"
                drag={coarsePointer ? "x" : false}
                dragConstraints={{ left: 0, right: 0 }}
                dragElastic={0.18}
                dragSnapToOrigin
                onDragEnd={onDragEnd}
                className="grid touch-pan-y gap-0 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]"
                aria-roledescription="slide"
                aria-label={`${index + 1} of ${chapters.length}: ${chapter.title}`}
              >
                <div className="h-[19rem] border-b border-border/60 bg-gradient-to-b from-muted/40 to-transparent p-4 sm:p-5 md:h-[19rem] md:border-r md:border-b-0">
                  <chapter.Preview />
                </div>
                <ChapterCopy chapter={chapter} planFlags={planFlags} comingSoon={comingSoon} facts={facts} />
              </motion.div>
            </AnimatePresence>
          </section>

          <div className="mt-4 flex items-center justify-between gap-3">
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="h-10"
              disabled={index === 0}
              onClick={prev}
              aria-label="Previous feature"
            >
              <ArrowLeft className="size-4" aria-hidden />
              <span className="hidden sm:inline">Previous</span>
            </Button>
            <p className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
              {index + 1} / {chapters.length}
            </p>
            <Button type="button" size="lg" className="h-10 px-4" onClick={next}>
              {index >= last ? "Go to dashboard" : "Next"}
              <ArrowRight className="size-4" aria-hidden />
            </Button>
          </div>
          <p className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-center text-xs text-muted-foreground lg:justify-end">
            {index < last && (
              <button
                type="button"
                onClick={onDone}
                className="underline-offset-4 hover:text-foreground hover:underline"
              >
                Skip to the dashboard
              </button>
            )}
            {onTour && (
              <button
                type="button"
                onClick={onTour}
                className="underline-offset-4 hover:text-foreground hover:underline"
              >
                Take the guided tour instead
              </button>
            )}
          </p>
        </StaggerItem>
      </div>
    </Stagger>
  );
}

type Slide = { dir: 1 | -1; travel: number };

/** Direction-aware slide; `travel` is 0 for reduced motion, leaving a crossfade. */
const SLIDE = {
  enter: ({ dir, travel }: Slide) => ({ opacity: 0, x: travel * dir }),
  center: { opacity: 1, x: 0, transition: { duration: DUR.slow, ease: EASE_HOUSE } },
  exit: ({ dir, travel }: Slide) => ({
    opacity: 0,
    x: -travel * dir,
    transition: { duration: DUR.base, ease: EASE_HOUSE },
  }),
};

function chapterSoon(chapter: HighlightChapter, comingSoon: ReadonlySet<string>) {
  return chapter.surfaceKey != null && comingSoon.has(chapter.surfaceKey);
}

function ChapterRail({
  chapters,
  index,
  planFlags,
  comingSoon,
  onSelect,
}: {
  chapters: HighlightChapter[];
  index: number;
  planFlags: PlanFlags;
  comingSoon: ReadonlySet<string>;
  onSelect: (i: number) => void;
}) {
  const railRef = useRef<HTMLOListElement>(null);
  // On a phone the rail is a horizontal strip; keep the current chapter in view as the
  // user swipes. Scrolls the strip only — `scrollIntoView` would also nudge the page.
  useEffect(() => {
    const rail = railRef.current;
    const item = rail?.children[index] as HTMLElement | undefined;
    if (!rail || !item || rail.scrollWidth <= rail.clientWidth) return;
    rail.scrollTo({ left: item.offsetLeft - 16, behavior: "smooth" });
  }, [index]);

  return (
    <ol
      ref={railRef}
      className="-mx-4 flex snap-x gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0"
      aria-label="Features"
    >
      {chapters.map((c, i) => {
        const Icon = c.icon;
        const active = i === index;
        const seen = i < index;
        const locked = c.entitlement && !planFlags[c.entitlement];
        const soon = chapterSoon(c, comingSoon);
        return (
          <li key={c.id} className="shrink-0 snap-start">
            <button
              type="button"
              onClick={() => onSelect(i)}
              aria-current={active ? "step" : undefined}
              className={cn(
                "relative flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition-colors",
                active ? "text-ink" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {active && (
                <motion.span
                  layoutId="onboarding-chapter-pill"
                  transition={SPRING_PILL}
                  aria-hidden
                  className="absolute inset-0 rounded-xl border border-border/70 bg-card shadow-sm"
                />
              )}
              <span
                className={cn(
                  "relative flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors",
                  active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                )}
              >
                {seen ? <Check className="size-3.5" aria-hidden /> : <Icon className="size-3.5" aria-hidden />}
              </span>
              <span className="relative whitespace-nowrap font-medium">{c.label}</span>
              {soon ? (
                <SoonTag className="relative ml-auto" />
              ) : (
                locked && <ProTag className="relative ml-auto" />
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function NeedTag({ chapter, facts }: { chapter: HighlightChapter; facts: OverviewFacts }) {
  const base =
    "inline-flex items-center rounded-full border border-border/70 bg-muted/40 px-2 py-px text-[11px] font-medium text-muted-foreground";
  if (chapter.needs === "ai" && !facts.hasApiKey) {
    return (
      <Link href={integrationHref("ai")} className={cn(base, "underline-offset-2 hover:text-foreground hover:underline")}>
        Needs AI key
      </Link>
    );
  }
  if (chapter.needs === "linkedin" && facts.linkedinPending) {
    return <span className={base}>Upload when your export arrives</span>;
  }
  return null;
}

function ChapterCopy({
  chapter,
  planFlags,
  comingSoon,
  facts,
}: {
  chapter: HighlightChapter;
  planFlags: PlanFlags;
  comingSoon: ReadonlySet<string>;
  facts: OverviewFacts;
}) {
  const Icon = chapter.icon;
  const chapterLocked = chapter.entitlement && !planFlags[chapter.entitlement];
  const soon = chapterSoon(chapter, comingSoon);
  return (
    // The min-height keeps the card from resizing between chapters on a phone, where the
    // copy stacks under the preview and differs in length chapter to chapter.
    <Stagger className="flex min-h-[17rem] flex-col gap-3 p-5 md:min-h-0">
      <StaggerItem className="flex flex-wrap items-center gap-2">
        <span className="flex size-9 items-center justify-center rounded-xl bg-accent text-primary">
          <Icon className="size-4.5" aria-hidden />
        </span>
        {soon ? <SoonTag /> : chapterLocked && <ProTag />}
        <NeedTag chapter={chapter} facts={facts} />
      </StaggerItem>
      <StaggerItem>
        <h2 className="font-[family-name:var(--font-display)] text-2xl tracking-tight text-ink text-balance">
          {chapter.title}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground text-pretty">{chapter.blurb}</p>
      </StaggerItem>
      <Stagger as="ul" className="space-y-2">
        {chapter.bullets.map((b) => (
          <StaggerItem as="li" key={b.label} className="flex items-start gap-2 text-sm text-foreground">
            <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            <span className="min-w-0">
              {b.label}
              {b.soon && <SoonTag className="ml-1.5 align-[1px]" />}
              {!b.soon && b.entitlement && !chapterLocked && !planFlags[b.entitlement] && (
                <ProTag className="ml-1.5 align-[1px]" />
              )}
            </span>
          </StaggerItem>
        ))}
      </Stagger>
    </Stagger>
  );
}
