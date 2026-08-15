"use client";

import { useRef } from "react";
import { motion, useScroll, useTransform, type MotionValue } from "motion/react";
import { scrub01 } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { Reveal } from "@/components/motion/reveal";

// dot/glow progress from white to gold across the 4 steps — the same
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

// 12 / 3 / 6 / 9 o'clock, sitting exactly on the dashed ring (inset-6%,
// i.e. radius 44% from center), matching STEPS in order.
const NODE_POSITIONS = [
  { top: "6%", left: "50%" },
  { top: "50%", left: "94%" },
  { top: "94%", left: "50%" },
  { top: "50%", left: "6%" },
] as const;

type Step = (typeof STEPS)[number];

/** Each step lights as the ring reaches it, so the loop builds in the order
 * the copy claims. Windows overlap by 0.06 so it reads as one sweep. */
function stepWindow(index: number): [number, number] {
  return [0.15 + index * 0.14, 0.35 + index * 0.14];
}

function StepNode({
  step,
  index,
  p,
  counter,
  reduced,
}: {
  step: Step;
  index: number;
  p: MotionValue<number>;
  counter: MotionValue<number>;
  reduced: boolean;
}) {
  const [a, b] = stepWindow(index);
  const opacity = useTransform(p, (v) => scrub01(v, a, b));

  return (
    // Outer element owns the ring placement; the inner one owns the
    // counter-rotation, so the label stays upright while its position swings.
    // The -6px is half the dot's own 12px diameter — it centers the DOT on
    // the ring rather than the whole text block. origin-top pivots that
    // counter-rotation at the dot itself (the div's top edge) rather than
    // its own center, which sits down in the body copy — otherwise the dot
    // swings off the ring by however tall each step's text happens to be.
    <div
      className="absolute w-[42%] max-w-[230px] text-center"
      style={{
        top: NODE_POSITIONS[index].top,
        left: NODE_POSITIONS[index].left,
        transform: "translate(-50%, -6px)",
      }}
    >
      <motion.div
        className="origin-top"
        style={reduced ? undefined : { rotate: counter, opacity }}
      >
        <span
          aria-hidden="true"
          className="mx-auto block h-3 w-3 rounded-full"
          style={{ background: step.dot, boxShadow: step.glow }}
        />
        <p className="mt-2 text-[11px] uppercase tracking-[0.16em] text-[#6d807c]">
          {step.kicker}
        </p>
        <p className="mt-1 font-[family-name:var(--font-display)] text-[19px] text-[#e8f3f1]">
          {step.title}
        </p>
        <p className="mt-1 text-[13px] leading-[1.6] text-[#9aada8]">
          {step.body}
        </p>
      </motion.div>
    </div>
  );
}

function StepRow({
  step,
  index,
  p,
  reduced,
}: {
  step: Step;
  index: number;
  p: MotionValue<number>;
  reduced: boolean;
}) {
  const [a, b] = stepWindow(index);
  const opacity = useTransform(p, (v) => scrub01(v, a, b));
  const x = useTransform(p, (v) => 14 * (1 - scrub01(v, a, b)));

  return (
    <motion.li
      className="relative flex gap-4"
      style={reduced ? undefined : { opacity, x }}
    >
      <span
        aria-hidden="true"
        className="relative z-10 mt-1.5 h-3 w-3 shrink-0 rounded-full"
        style={{ background: step.dot, boxShadow: step.glow }}
      />
      <div>
        <p className="text-[11px] uppercase tracking-[0.16em] text-[#6d807c]">
          {step.kicker}
        </p>
        <p className="mt-1 font-[family-name:var(--font-display)] text-[19px] text-[#e8f3f1]">
          {step.title}
        </p>
        <p className="mt-1 text-[13px] leading-[1.6] text-[#9aada8]">
          {step.body}
        </p>
      </div>
    </motion.li>
  );
}

export function LandingHowItWorks() {
  const sectionRef = useRef<HTMLElement>(null);
  const reduced = usePrefersReducedMotion();

  // Measured on the section, not the ring: the ring is itself rotated, and a
  // rotated element's bounding box changes size as it turns, which would feed
  // the rotation back into its own progress.
  // Ends at "end center" rather than "end start" so the loop finishes
  // drawing while the section is still centered in view, not exactly as
  // it scrolls out of frame.
  const { scrollYProgress: p } = useScroll({
    target: sectionRef,
    offset: ["start end", "end center"],
  });

  // Eases to 0° (dots seated on the ring's top/right/bottom/left marks) by
  // the halfway point, then holds — the dots settle onto the line instead
  // of sweeping past it for the rest of the scroll.
  const rotate = useTransform(p, (v) => scrub01(v, 0, 0.5) * 17 - 17);
  const counter = useTransform(rotate, (r) => -r);
  const ringDraw = useTransform(p, (v) => scrub01(v, 0.12, 0.6));
  const dashedOpacity = useTransform(
    p,
    (v) => 0.25 + 0.75 * scrub01(v, 0.05, 0.4)
  );
  const spineDraw = useTransform(p, (v) => scrub01(v, 0.12, 0.9));

  return (
    <section
      ref={sectionRef}
      aria-labelledby="landing-how"
      className="landing-scene scene-how relative z-10 mx-auto w-full max-w-6xl border-t border-[#e8f3f1]/[0.07] px-6 py-20 md:px-10 md:py-24"
    >
      <Reveal className="reveal-celestial">
        <p className="text-xs uppercase tracking-[0.18em] text-[#f2c14e]">
          How it works
        </p>
      </Reveal>
      <Reveal className="reveal-celestial" delay={80}>
        <h2
          id="landing-how"
          className="mt-3 max-w-[18ch] font-[family-name:var(--font-display)] text-[clamp(30px,4.4vw,50px)] font-normal leading-[1.15] tracking-[-0.025em] text-[#e8f3f1]"
        >
          From a conversation to a callback.
        </h2>
      </Reveal>

      <div className="relative mx-auto mt-16 hidden aspect-square w-full max-w-[760px] lg:block">
        <motion.div
          className="absolute inset-0"
          style={reduced ? undefined : { rotate }}
        >
          {/* Dashed ring stays a border rather than an SVG path: motion's
              pathLength drives stroke-dasharray, so a dashed stroke can't
              also draw itself. It fades in instead. */}
          <motion.div
            aria-hidden="true"
            className="absolute inset-[6%] rounded-full border border-dashed border-[#e8f3f1]/[0.13]"
            style={reduced ? undefined : { opacity: dashedOpacity }}
          />
          <svg
            aria-hidden="true"
            viewBox="0 0 100 100"
            className="absolute inset-[24%] h-auto w-auto"
          >
            <motion.circle
              cx={50}
              cy={50}
              r={49}
              fill="none"
              stroke="rgba(232,243,241,0.07)"
              strokeWidth={1}
              transform="rotate(-90 50 50)"
              style={reduced ? undefined : { pathLength: ringDraw }}
            />
          </svg>
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

          {STEPS.map((step, index) => (
            <StepNode
              key={step.title}
              step={step}
              index={index}
              p={p}
              counter={counter}
              reduced={reduced}
            />
          ))}
        </motion.div>

        {/* Outside the rotating ring entirely — stays fixed under the sun
            regardless of scroll rotation, no counter-rotation needed. */}
        <div
          className="absolute left-1/2 -translate-x-1/2 text-center"
          style={{ top: "calc(50% + 48px)" }}
        >
          <p className="font-[family-name:var(--font-display)] text-[19px] text-[#e8f3f1]">
            Orbit
          </p>
          <p className="text-xs text-[#6d807c]">the record keeps itself</p>
        </div>
      </div>

      {/* Below lg the ring can't shrink without going illegible, so the loop
          becomes a vertical timeline — same beat (it builds as you scroll),
          different geometry. The spine draws down as the steps light. */}
      <div className="relative mt-12 lg:hidden">
        <svg
          aria-hidden="true"
          viewBox="0 0 1 100"
          preserveAspectRatio="none"
          className="absolute left-[5.5px] top-2 h-[calc(100%-1rem)] w-px overflow-visible"
        >
          <motion.line
            x1={0.5}
            y1={0}
            x2={0.5}
            y2={100}
            stroke="rgba(232,243,241,0.16)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            style={reduced ? undefined : { pathLength: spineDraw }}
          />
        </svg>
        <ol className="space-y-6">
          {STEPS.map((step, index) => (
            <StepRow
              key={step.title}
              step={step}
              index={index}
              p={p}
              reduced={reduced}
            />
          ))}
        </ol>
      </div>

      {/* lg:mt-20 clears the "Send outreach" node's text, which flows
          downward from its dot near the ring's own bottom edge and would
          otherwise overlap this caption. */}
      <Reveal className="reveal-celestial">
        <p className="mt-8 text-center text-sm text-[#6d807c] lg:mt-20">
          It keeps working in the background, even when you close the app.
        </p>
      </Reveal>
    </section>
  );
}
