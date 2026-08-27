"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useScroll, useTransform, type MotionValue } from "motion/react";
import { scrub01 } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { Reveal } from "@/components/motion/reveal";
import { EarthGlobeMount } from "@/components/landing/earth-globe-mount";
import { useIsLg } from "@/components/landing/use-is-lg";
import {
  BEATS,
  centreY,
  EARTH_RATIO,
  HEADER_CLEARANCE,
  LABEL_GAP,
  LABEL_H,
  LABEL_W,
  PIN_SVH,
  RING_RATIO,
  STAGE_MAX,
  STAGE_MIN,
  stageSize,
  stepWindow,
  type Geom,
} from "@/components/landing/how-it-works-choreography";

// Marker/glow progress from white to gold across the 4 steps — the same
// escalation the reply-rate bars used, so "further along the loop" reads as
// "warmer" everywhere on the page.
const STEPS = [
  {
    kicker: "Step 01 · you",
    title: "Connect",
    body: "Link LinkedIn and Gmail once — no CSVs, no manual entry.",
    dot: "#e8f3f1",
    glow: "0 0 20px rgba(232,243,241,.5)",
  },
  {
    kicker: "Step 02 · automatic",
    title: "Contacts populate",
    body: "Everyone you talk to during your search shows up, already filled in.",
    dot: "#ebe2bb",
    glow: "none",
  },
  {
    kicker: "Step 03 · you",
    title: "Send outreach",
    body: "Find people at the companies you're targeting, and reach out from Orbit.",
    dot: "#efd284",
    glow: "none",
  },
  {
    kicker: "Step 04 · automatic",
    title: "Replies come back",
    body: "Orbit tracks who replied — and nudges you about who you still owe a follow-up.",
    dot: "#f2c14e",
    glow: "0 0 20px rgba(242,193,78,.6)",
  },
] as const;

type Step = (typeof STEPS)[number];

/**
 * The four nodes, at 12 / 3 / 6 / 9 o'clock on the dashed ring (inset-6%,
 * i.e. radius 44% from centre), matching STEPS in order.
 *
 * Labels sit *outside* the ring rather than under their node: Earth is 2×
 * EARTH_RATIO of the stage wide and passes directly over every node, so
 * anything sitting on one would be covered as it went by. `out` is the
 * outward direction, used both to place the label and to give it a short
 * radial slide as it arrives.
 */
const NODES = [
  { top: "6%", left: "50%", out: [0, -1], align: "text-center" },
  { top: "50%", left: "94%", out: [1, 0], align: "text-left" },
  { top: "94%", left: "50%", out: [0, 1], align: "text-center" },
  { top: "50%", left: "6%", out: [-1, 0], align: "text-right" },
] as const;

/** How far a label slides outward as it reveals. */
const LABEL_SLIDE = 14;

/**
 * Pre-measurement stage size and centre — the algebraic form of `stageSize()`
 * and `centreY()`, generated from the same constants so the one painted frame
 * before the ResizeObserver reports matches what replaces it.
 *
 *   byHeight = ((h - CLEAR)/2 - (LABEL_H + GAP)) / OUTER
 *   byWidth  = (w/2 - (LABEL_W + GAP + 16)) / OUTER
 */
const OUTER = RING_RATIO + EARTH_RATIO;
const H_TERM = (HEADER_CLEARANCE / 2 + LABEL_H + LABEL_GAP) / OUTER;
const W_TERM = (LABEL_W + LABEL_GAP + 16) / OUTER;
const STAGE_CSS = `max(${STAGE_MIN}px, min(${STAGE_MAX}px, calc(50svh / ${OUTER} - ${Math.round(H_TERM)}px), calc(50vw / ${OUTER} - ${Math.round(W_TERM)}px)))`;
const CENTRE_CSS = `calc(50% + ${HEADER_CLEARANCE / 2}px)`;

const KICKER_CLASS = "text-[11px] uppercase tracking-[0.16em] text-[#6d807c]";
const TITLE_CLASS =
  "mt-1 font-[family-name:var(--font-display)] text-[19px] text-[#e8f3f1]";
const BODY_CLASS = "mt-1 text-[13px] leading-[1.6] text-[#9aada8]";

function StepLabel({
  step,
  index,
  p,
}: {
  step: Step;
  index: number;
  p: MotionValue<number>;
}) {
  const node = NODES[index];
  const [a, b] = stepWindow(index);
  const reveal = useTransform(p, (v) => scrub01(v, a, b));
  const opacity = useTransform(
    p,
    (v) => scrub01(v, a, b) * (1 - scrub01(v, ...BEATS.sceneOut))
  );
  // Range maps are fine for pure transforms — only opacity/pathLength have to
  // stay function transforms (see scrub01's doc comment).
  const x = useTransform(reveal, [0, 1], [-LABEL_SLIDE * node.out[0], 0]);
  const y = useTransform(reveal, [0, 1], [-LABEL_SLIDE * node.out[1], 0]);

  // Anchored at the node, then pushed clear of Earth's path along `out`.
  const shift = "calc(var(--label-gap) * 1)";
  const tx =
    node.out[0] === 0 ? "-50%" : node.out[0] > 0 ? shift : `calc(-100% - ${shift})`;
  const ty =
    node.out[1] === 0 ? "-50%" : node.out[1] > 0 ? shift : `calc(-100% - ${shift})`;

  return (
    <div
      className="absolute w-[230px]"
      style={{ top: node.top, left: node.left, transform: `translate(${tx}, ${ty})` }}
    >
      <motion.div className={node.align} style={{ opacity, x, y }}>
        <p className={KICKER_CLASS}>{step.kicker}</p>
        <p className={TITLE_CLASS}>{step.title}</p>
        <p className={BODY_CLASS}>{step.body}</p>
      </motion.div>
    </div>
  );
}

/** The ring left behind at each node once Earth has passed over it. */
function StepMarker({
  step,
  index,
  p,
}: {
  step: Step;
  index: number;
  p: MotionValue<number>;
}) {
  const node = NODES[index];
  const [a, b] = stepWindow(index);
  const reveal = useTransform(p, (v) => scrub01(v, a, b));
  const opacity = useTransform(
    p,
    (v) => scrub01(v, a, b) * (1 - scrub01(v, ...BEATS.sceneOut))
  );

  return (
    <motion.span
      aria-hidden="true"
      className="absolute block h-[10px] w-[10px] rounded-full border-[1.5px]"
      style={{
        top: node.top,
        left: node.left,
        borderColor: step.dot,
        boxShadow: step.glow,
        translateX: "-50%",
        translateY: "-50%",
        opacity,
        scale: reveal,
      }}
    />
  );
}

/** Below lg the ring can't shrink without going illegible, so the loop
 * becomes a vertical timeline — same beat (it builds as you scroll),
 * different geometry. One dot runs down the spine, trailing a filled line
 * behind it, and each step lights as the dot lands on its marker. */

/** Scrub range the dot travels over. The margins keep it from sitting exactly
 * on the first/last marker at the very ends of the range, where sub-pixel
 * scroll jitter would make it look stuck. */
const DOT_RUN: [number, number] = [0.04, 0.96];
/** How far ahead of the dot a step starts fading up, and how long the marker
 * takes to fill once the dot is on it. */
const COPY_LEAD = 0.07;
const MARK_FILL = 0.02;

/** Centre of each marker, in px from the top of the list. */
function useMarkerOffsets(listRef: React.RefObject<HTMLOListElement | null>) {
  const [marks, setMarks] = useState<number[]>([]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const top = list.getBoundingClientRect().top;
      const next = Array.from(
        list.querySelectorAll<HTMLElement>("[data-step-marker]"),
        (el) => {
          const r = el.getBoundingClientRect();
          return r.top - top + r.height / 2;
        }
      );
      // Measured rather than assumed even spacing: the bodies wrap to
      // different heights, so evenly-spaced windows drifted off the markers.
      setMarks((prev) =>
        prev.length === next.length &&
        prev.every((v, i) => Math.abs(v - next[i]!) < 0.5)
          ? prev
          : next
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    return () => ro.disconnect();
  }, [listRef]);

  return marks;
}

function StepRow({
  step,
  p,
  arrival,
  reduced,
}: {
  step: Step;
  p: MotionValue<number>;
  arrival: number;
  reduced: boolean;
}) {
  const opacity = useTransform(p, (v) =>
    scrub01(v, arrival - COPY_LEAD, arrival + MARK_FILL)
  );
  const x = useTransform(p, (v) =>
    14 * (1 - scrub01(v, arrival - COPY_LEAD, arrival + MARK_FILL))
  );
  const lit = useTransform(p, (v) =>
    scrub01(v, arrival - MARK_FILL, arrival + MARK_FILL)
  );

  return (
    <motion.li
      className="relative flex gap-4"
      style={reduced ? undefined : { opacity, x }}
    >
      <span
        data-step-marker
        aria-hidden="true"
        className="relative z-10 mt-1.5 h-3 w-3 shrink-0 rounded-full border border-[#e8f3f1]/25 bg-[#03050c]"
      >
        {/* Fills in as the dot lands, in that step's colour. */}
        <motion.span
          className="absolute inset-[2px] rounded-full"
          style={{
            background: step.dot,
            boxShadow: step.glow,
            ...(reduced ? { opacity: 1 } : { opacity: lit }),
          }}
        />
      </span>
      <div>
        <p className={KICKER_CLASS}>{step.kicker}</p>
        <p className={TITLE_CLASS}>{step.title}</p>
        <p className={BODY_CLASS}>{step.body}</p>
      </div>
    </motion.li>
  );
}

function MobileTimeline({ reduced }: { reduced: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const marks = useMarkerOffsets(listRef);

  // Completes while the whole timeline is still comfortably on screen — the
  // old "end center" range ran on for another half viewport after the last
  // step had already lit.
  const { scrollYProgress: p } = useScroll({
    target: ref,
    offset: ["start 0.9", "end 0.8"],
  });

  const first = marks[0] ?? 0;
  const last = marks.length ? marks[marks.length - 1]! : 0;
  const travel = Math.max(0, last - first);

  const dotY = useTransform(
    p,
    (v) => first + travel * scrub01(v, ...DOT_RUN)
  );
  const fillH = useTransform(dotY, (y) => Math.max(0, y - first));

  return (
    <div ref={ref} className="relative mt-12 lg:hidden">
      {/* Track, then the filled length the dot leaves behind it. Both span
       * marker-to-marker rather than the list box, so the line starts and
       * stops on a step instead of floating past the ends. */}
      <div
        aria-hidden="true"
        className="absolute left-[5.5px] w-px bg-[#e8f3f1]/[0.14]"
        style={{ top: first, height: travel }}
      />
      <motion.div
        aria-hidden="true"
        className="absolute left-[5.5px] w-px bg-[linear-gradient(to_bottom,rgba(232,243,241,0.45),rgba(242,193,78,0.75))]"
        style={{ top: first, height: reduced ? travel : fillH }}
      />
      {!reduced && travel > 0 && (
        <motion.span
          aria-hidden="true"
          className="absolute left-[6px] top-0 z-20 block h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#f2c14e] shadow-[0_0_12px_rgba(242,193,78,0.85)]"
          style={{ y: dotY }}
        />
      )}
      <ol ref={listRef} className="space-y-6">
        {STEPS.map((step, index) => (
          <StepRow
            key={step.title}
            step={step}
            p={p}
            arrival={
              travel > 0
                ? DOT_RUN[0] +
                  (DOT_RUN[1] - DOT_RUN[0]) * ((marks[index]! - first) / travel)
                : index / Math.max(1, STEPS.length - 1)
            }
            reduced={reduced}
          />
        ))}
      </ol>
    </div>
  );
}

/** Ring furniture — shared by the pin and the reduced-motion still. */
function Ring() {
  return (
    <>
      {/* Dashed ring stays a border rather than an SVG path: motion's
          pathLength drives stroke-dasharray, so a dashed stroke can't also
          draw itself. It arrives as a complete circle instead — the loop is
          in place before Earth starts walking it. */}
      <div
        aria-hidden="true"
        className="absolute inset-[6%] rounded-full border border-dashed border-[#e8f3f1]/[0.13]"
      />
      <div
        aria-hidden="true"
        className="absolute inset-[24%] rounded-full border border-[#e8f3f1]/[0.07]"
      />
      <div
        aria-hidden="true"
        className="absolute inset-[34%] rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(242,193,78,.16), transparent 70%)",
        }}
      />
      <div
        aria-hidden="true"
        className="absolute left-1/2 top-1/2 h-[78px] w-[78px] -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          background:
            "radial-gradient(circle at 46% 42%, #fffdf2 6%, #ffe89a 34%, #f5c451 62%, #eba92c 100%)",
          boxShadow: "0 0 60px 14px rgba(245,196,81,0.35)",
        }}
      />
      <div
        className="absolute left-1/2 -translate-x-1/2 text-center"
        style={{ top: "calc(50% + 48px)" }}
      >
        <p className="font-[family-name:var(--font-display)] text-[19px] text-[#e8f3f1]">
          Orbit
        </p>
        <p className="text-xs text-[#6d807c]">the record keeps itself</p>
      </div>
    </>
  );
}

/** Reduced-motion still: the finished loop, no pin and no scroll bindings. */
function StaticRing() {
  return (
    <div
      className="relative mx-auto mt-16 hidden aspect-square lg:block"
      style={{ width: STAGE_CSS, ["--label-gap" as string]: "60px" }}
    >
      <Ring />
      {STEPS.map((step, index) => {
        const node = NODES[index];
        return (
          <span
            key={step.title}
            aria-hidden="true"
            className="absolute block h-[10px] w-[10px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px]"
            style={{
              top: node.top,
              left: node.left,
              borderColor: step.dot,
              boxShadow: step.glow,
            }}
          />
        );
      })}
      {STEPS.map((step, index) => {
        const node = NODES[index];
        const tx =
          node.out[0] === 0
            ? "-50%"
            : node.out[0] > 0
              ? "var(--label-gap)"
              : "calc(-100% - var(--label-gap))";
        const ty =
          node.out[1] === 0
            ? "-50%"
            : node.out[1] > 0
              ? "var(--label-gap)"
              : "calc(-100% - var(--label-gap))";
        return (
          <div
            key={step.title}
            className={`absolute w-[230px] ${node.align}`}
            style={{
              top: node.top,
              left: node.left,
              transform: `translate(${tx}, ${ty})`,
            }}
          >
            <p className={KICKER_CLASS}>{step.kicker}</p>
            <p className={TITLE_CLASS}>{step.title}</p>
            <p className={BODY_CLASS}>{step.body}</p>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The pinned Earth journey (lg + full motion only).
 *
 * Beats live in how-it-works-choreography.ts, which both this component and
 * the WebGL globe read — the DOM owns the ring, sun, arc, markers and labels;
 * the globe's own rAF owns Earth. Neither writes the other's nodes.
 */
function EarthJourney({ reduced, isLg }: { reduced: boolean; isLg: boolean }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [geom, setGeom] = useState<Geom>({ w: 0, h: 0, ringR: 0 });

  const { scrollYProgress: p } = useScroll({
    target: wrapRef,
    offset: ["start start", "end end"],
  });

  // Picks up where `p` clamps: 0 the moment the pin releases, 1 once the
  // wrapper's bottom edge clears the top of the viewport. Nothing else can
  // drive the globe after the sticky frame stops moving relative to it.
  const { scrollYProgress: depart } = useScroll({
    target: wrapRef,
    offset: ["end end", "end start"],
  });

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => {
      const w = frame.clientWidth;
      const h = frame.clientHeight;
      setGeom((prev) =>
        prev.w === w && prev.h === h
          ? prev
          : { w, h, ringR: stageSize(w, h) * RING_RATIO }
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(frame);
    return () => ro.disconnect();
  }, []);

  const sceneOpacity = useTransform(
    p,
    (v) => scrub01(v, ...BEATS.sceneIn) * (1 - scrub01(v, ...BEATS.sceneOut))
  );
  const stage = geom.ringR ? `${geom.ringR / RING_RATIO}px` : STAGE_CSS;
  const centre = geom.h ? `${centreY(geom.h)}px` : CENTRE_CSS;
  const labelGap = geom.ringR
    ? `${(geom.ringR / RING_RATIO) * EARTH_RATIO + LABEL_GAP}px`
    : `calc(${STAGE_CSS} * ${EARTH_RATIO} + ${LABEL_GAP}px)`;

  return (
    // The breakpoint gate is CSS, not JS: rendering the wrapper only after
    // useIsLg() resolves would grow the page by 460svh at hydration on every
    // load. Reduced motion still branches in JS — same trade HeroPin makes.
    <div
      ref={wrapRef}
      className={reduced ? "hidden" : "hidden lg:block"}
      style={reduced ? undefined : { height: `${PIN_SVH}svh` }}
    >
      {/* select-none: the whole frame is a drag surface for the globe, and a
          pull that leaves a trail of highlighted step copy behind it reads as
          the page breaking rather than as the planet being turned. */}
      <div
        ref={frameRef}
        className="sticky top-0 h-svh select-none overflow-hidden"
      >
        {/* Ring furniture sits under Earth: it passes in front of the dashed
            line and the markers it stamps, and covers the sun at both the
            opening hold and the full-bleed finale. */}
        <motion.div
          aria-hidden="true"
          className="absolute left-1/2 aspect-square -translate-x-1/2 -translate-y-1/2 z-10"
          style={{ width: stage, top: centre, opacity: sceneOpacity }}
        >
          <Ring />
        </motion.div>

        {/* Node markers sit under the globe, not with the labels: Earth
            passes directly over every node, and a marker drawn on top of it
            would punch a hole through the planet. */}
        <div
          aria-hidden="true"
          className="absolute left-1/2 aspect-square -translate-x-1/2 -translate-y-1/2 z-10"
          style={{ width: stage, top: centre }}
        >
          {STEPS.map((step, index) => (
            <StepMarker key={step.title} step={step} index={index} p={p} />
          ))}
        </div>

        <div className="absolute inset-0 z-20">
          <EarthGlobeMount
            progress={p}
            depart={depart}
            frameRef={frameRef}
            enabled={isLg && !reduced}
            geom={geom}
          />
        </div>

        <div
          className="absolute left-1/2 aspect-square -translate-x-1/2 -translate-y-1/2 z-30"
          style={{ width: stage, top: centre, ["--label-gap" as string]: labelGap }}
        >
          {STEPS.map((step, index) => (
            <StepLabel key={step.title} step={step} index={index} p={p} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function LandingHowItWorks() {
  const reduced = usePrefersReducedMotion();
  const isLg = useIsLg();

  // The heading and the pin must share one .landing-scene: the header's
  // scroll spy resolves its highlight via anchor.closest(".landing-scene")
  // (use-active-landing-section.ts), so splitting them would drop the "How it
  // works" pill for the whole pin.
  return (
    <section
      aria-labelledby="how-heading"
      className="landing-scene scene-how relative z-10"
    >
      <div
        id="how"
        className="mx-auto w-full max-w-6xl px-8 pt-20 md:px-10 md:pt-24"
      >
        <Reveal className="reveal-celestial">
          <p className="text-xs uppercase tracking-[0.18em] text-[#f2c14e]">
            How it works
          </p>
        </Reveal>
        <Reveal className="reveal-celestial" delay={80}>
          <h2
            id="how-heading"
            className="mt-3 max-w-[18ch] font-[family-name:var(--font-display)] text-[clamp(30px,4.4vw,50px)] font-normal leading-[1.15] tracking-[-0.025em] text-[#e8f3f1]"
          >
            From a conversation to a callback.
          </h2>
        </Reveal>
      </div>

      <EarthJourney reduced={reduced} isLg={isLg} />
      {reduced ? <StaticRing /> : null}

      {/* Padding is for the mobile timeline only — at lg this wrapper is
          empty (the timeline is lg:hidden) and its bottom padding was pure
          dead space between the departing globe and the next scene. */}
      <div className="mx-auto w-full max-w-6xl px-8 pb-20 md:px-10 md:pb-24 lg:pb-0">
        <MobileTimeline reduced={reduced} />
      </div>
    </section>
  );
}
