"use client";

import { useRef } from "react";
import { motion, useScroll, useTransform, type MotionValue } from "motion/react";
import { scrub01 } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/**
 * Scroll-scrubbed mini mockups for the features scene — each card tells its
 * story as it crosses the viewport (reversible, Apple-style). All scrubs are
 * scrub01 function transforms (transforms/opacity/pathLength only), and each
 * component is its own reduced-motion gate: reduced ⇒ static end state.
 */

function useCardProgress() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start 0.92", "center 0.5"],
  });
  const reduced = usePrefersReducedMotion();
  return { ref, p: scrollYProgress, reduced };
}

type P = MotionValue<number>;

/** Two source cards converge; the merged record arrives last. */
export function ContactsVisual() {
  const { ref, p, reduced } = useCardProgress();
  const sA = (v: number) => scrub01(v, 0, 0.7);
  const sB = (v: number) => scrub01(v, 0.1, 0.8);
  const sM = (v: number) => scrub01(v, 0.5, 1);

  const a = {
    x: useTransform(p, (v) => -36 * (1 - sA(v))),
    y: useTransform(p, (v) => -14 * (1 - sA(v))),
    rotate: useTransform(p, (v) => -14 + 8 * sA(v)),
    opacity: useTransform(p, (v) => 0.4 + 0.6 * sA(v)),
  };
  const b = {
    x: useTransform(p, (v) => -30 * (1 - sB(v))),
    y: useTransform(p, (v) => 18 * (1 - sB(v))),
    rotate: useTransform(p, (v) => 11 - 8 * sB(v)),
    opacity: useTransform(p, (v) => 0.4 + 0.6 * sB(v)),
  };
  const merged = {
    opacity: useTransform(p, (v) => sM(v)),
    y: useTransform(p, (v) => 18 * (1 - sM(v))),
    scale: useTransform(p, (v) => 0.92 + 0.08 * sM(v)),
  };

  return (
    <div ref={ref} className="relative h-[195px] w-full lg:h-[200px]" aria-hidden>
      <motion.div
        className="absolute left-0 top-0 w-[118px] rounded-2xl border border-[#e8f3f1]/10 bg-[#05070f]/70 px-2.5 py-2 lg:top-3.5 lg:w-[154px] lg:px-3.5 lg:py-3"
        style={reduced ? { rotate: -6 } : a}
      >
        <p className="text-[10px] uppercase tracking-wide text-[#6d807c] lg:text-[11px]">LinkedIn</p>
        <p className="mt-1.5 text-xs text-[#e8f3f1] lg:text-sm">Priya Raman</p>
        <p className="text-[11px] text-[#9aada8] lg:text-xs">Head of Growth</p>
      </motion.div>
      <motion.div
        className="absolute left-7 top-[98px] w-[118px] rounded-2xl border border-[#e8f3f1]/10 bg-[#05070f]/70 px-2.5 py-2 lg:left-11 lg:top-[104px] lg:w-[154px] lg:px-3.5 lg:py-3"
        style={reduced ? { rotate: 3 } : b}
      >
        <p className="text-[10px] uppercase tracking-wide text-[#6d807c] lg:text-[11px]">Gmail</p>
        <p className="mt-1.5 text-xs text-[#e8f3f1] lg:text-sm">priya@northwind.io</p>
        <p className="text-[11px] text-[#9aada8] lg:text-xs">Northwind · last week</p>
      </motion.div>
      <motion.div
        className="absolute right-0 top-12 w-[136px] rounded-2xl border border-[#c4a35a]/35 bg-[#c4a35a]/[0.07] p-3 shadow-[0_0_40px_rgba(196,163,90,0.14)] lg:top-11 lg:w-[190px] lg:p-4"
        style={reduced ? undefined : merged}
      >
        <div className="h-[24px] w-[24px] rounded-full bg-[#e8f3f1]/15 lg:h-[30px] lg:w-[30px]" />
        <p className="mt-2 text-xs text-[#e8f3f1] lg:text-sm">Priya Raman</p>
        <p className="text-[11px] text-[#9aada8] lg:text-xs">Northwind</p>
        <p className="mt-2 text-[10px] uppercase tracking-wide text-[#c4a35a] lg:text-[11px]">One record</p>
      </motion.div>
    </div>
  );
}

const MINI_STARS: Array<[number, number, number]> = [
  [28, 96, 2.6],
  [62, 58, 2.2],
  [104, 76, 3.4],
  [142, 40, 2.4],
  [168, 88, 2.8],
  [122, 116, 2.0],
];
const MINI_MAIN_PATH = "M 28 96 L 62 58 L 104 76 L 142 40 L 168 88";
const MINI_BRANCH_PATH = "M 104 76 L 122 116";

/** The cluster draws its own chains in. */
export function ConstellationVisual({ label }: { label: string }) {
  const { ref, p, reduced } = useCardProgress();
  const main = useTransform(p, (v) => scrub01(v, 0.05, 0.7));
  const branch = useTransform(p, (v) => scrub01(v, 0.55, 0.9));
  const starsOpacity = useTransform(p, (v) => 0.3 + 0.7 * scrub01(v, 0, 0.4));
  const labelOpacity = useTransform(p, (v) => scrub01(v, 0.7, 1));

  return (
    <div ref={ref} className="relative mx-auto w-full max-w-[320px]" aria-hidden>
      <svg viewBox="0 0 200 150" className="h-auto w-full">
        <motion.path
          d={MINI_MAIN_PATH}
          fill="none"
          stroke="rgba(89,157,231,0.55)"
          strokeWidth={1.1}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={reduced ? undefined : { pathLength: main }}
        />
        <motion.path
          d={MINI_BRANCH_PATH}
          fill="none"
          stroke="rgba(89,157,231,0.55)"
          strokeWidth={1.1}
          strokeLinecap="round"
          style={reduced ? undefined : { pathLength: branch }}
        />
        <motion.g style={reduced ? undefined : { opacity: starsOpacity }}>
          {MINI_STARS.map(([x, y, r], i) => (
            <circle key={i} cx={x} cy={y} r={r} fill="#c5d4d1" />
          ))}
        </motion.g>
      </svg>
      <motion.span
        className="absolute bottom-0 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-[#05070f]/70 px-2.5 py-1 text-[10px] uppercase tracking-[0.2em] text-[#c4a35a]"
        style={reduced ? undefined : { opacity: labelOpacity }}
      >
        {label}
      </motion.span>
    </div>
  );
}

function ReminderRow({
  p,
  reduced,
  window: [a, b],
  children,
  className,
}: {
  p: P;
  reduced: boolean;
  window: [number, number];
  children: React.ReactNode;
  className: string;
}) {
  const x = useTransform(p, (v) => -18 * (1 - scrub01(v, a, b)));
  const opacity = useTransform(p, (v) => scrub01(v, a, b));
  return (
    <motion.div className={className} style={reduced ? undefined : { x, opacity }}>
      {children}
    </motion.div>
  );
}

/** The day's nudges slide onto the list one by one. */
export function RemindersVisual() {
  const { ref, p, reduced } = useCardProgress();
  return (
    <div ref={ref} className="w-full max-w-[340px]" aria-hidden>
      <p className="text-[10px] uppercase tracking-[0.16em] text-[#6d807c]">Today</p>
      <div className="mt-2 space-y-2">
        <ReminderRow
          p={p}
          reduced={reduced}
          window={[0.1, 0.45]}
          className="flex items-center gap-3 rounded-xl border border-[#e8f3f1]/10 bg-[#05070f]/60 px-3.5 py-2.5"
        >
          <span className="h-6 w-6 shrink-0 rounded-full bg-[#0f3d3e] text-center text-[10px] leading-6 text-[#e8f3f1]">
            SC
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-[#e8f3f1]">Sarah Chen</p>
            <p className="text-[10px] text-[#9aada8]">Monthly check-in</p>
          </div>
          <span className="shrink-0 rounded-full bg-[#c4a35a]/15 px-2 py-0.5 text-[10px] text-[#c4a35a]">
            Due
          </span>
        </ReminderRow>
        <ReminderRow
          p={p}
          reduced={reduced}
          window={[0.3, 0.65]}
          className="flex items-center gap-3 rounded-xl border border-[#e8f3f1]/10 bg-[#05070f]/60 px-3.5 py-2.5"
        >
          <span className="h-6 w-6 shrink-0 rounded-full bg-[#2d3a48] text-center text-[10px] leading-6 text-[#e8f3f1]">
            MW
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-[#e8f3f1]">Marcus Webb</p>
            <p className="text-[10px] text-[#9aada8]">3 weeks quiet</p>
          </div>
          <span className="shrink-0 rounded-full bg-[#ff6b4a]/15 px-2 py-0.5 text-[10px] text-[#ff6b4a]">
            Drifting
          </span>
        </ReminderRow>
        <ReminderRow
          p={p}
          reduced={reduced}
          window={[0.5, 0.85]}
          className="flex items-center gap-3 rounded-xl bg-[#e8f3f1]/[0.035] px-3.5 py-2.5 opacity-50"
        >
          <span className="h-6 w-6 shrink-0 rounded-full bg-[#e8f3f1]/10" />
          <div className="flex-1 space-y-1.5">
            <div className="h-2 w-1/2 rounded-full bg-[#e8f3f1]/10" />
            <div className="h-2 w-1/3 rounded-full bg-[#e8f3f1]/10" />
          </div>
        </ReminderRow>
      </div>
    </div>
  );
}

/** You ask; the answer arrives. */
export function AskVisual() {
  const { ref, p, reduced } = useCardProgress();
  const q = {
    y: useTransform(p, (v) => -14 * (1 - scrub01(v, 0.05, 0.45))),
    opacity: useTransform(p, (v) => scrub01(v, 0.05, 0.45)),
  };
  const a = {
    y: useTransform(p, (v) => 14 * (1 - scrub01(v, 0.45, 0.9))),
    opacity: useTransform(p, (v) => scrub01(v, 0.45, 0.9)),
  };
  return (
    <div ref={ref} className="w-full max-w-[340px] space-y-3" aria-hidden>
      <motion.div
        className="flex items-center gap-3 rounded-2xl border border-[#e8f3f1]/[0.14] bg-[#05070f]/60 px-4 py-3"
        style={reduced ? undefined : q}
      >
        <p className="flex-1 text-sm text-[#e8f3f1]">Who do I know at Stripe?</p>
        <span className="h-6 w-6 shrink-0 rounded-full bg-[#c4a35a]/25" />
      </motion.div>
      <motion.div
        className="ml-6 flex items-center gap-2.5 rounded-2xl bg-[#e8f3f1]/[0.05] px-4 py-3"
        style={reduced ? undefined : a}
      >
        <span className="h-5 w-5 rounded-full bg-[#599de7]/40" />
        <span className="-ml-4 h-5 w-5 rounded-full bg-[#c4a35a]/40" />
        <p className="text-xs text-[#9aada8]">
          Two people — Elena via AWS, Tom from your MIT cluster.
        </p>
      </motion.div>
    </div>
  );
}

/** Source chips pop in, the import bar fills, the count lands. */
export function ImportsVisual() {
  const { ref, p, reduced } = useCardProgress();
  const chip0 = {
    opacity: useTransform(p, (v) => scrub01(v, 0.05, 0.3)),
    scale: useTransform(p, (v) => 0.8 + 0.2 * scrub01(v, 0.05, 0.3)),
  };
  const chip1 = {
    opacity: useTransform(p, (v) => scrub01(v, 0.17, 0.42)),
    scale: useTransform(p, (v) => 0.8 + 0.2 * scrub01(v, 0.17, 0.42)),
  };
  const chip2 = {
    opacity: useTransform(p, (v) => scrub01(v, 0.29, 0.54)),
    scale: useTransform(p, (v) => 0.8 + 0.2 * scrub01(v, 0.29, 0.54)),
  };
  const chipStyles = [chip0, chip1, chip2];
  const barScale = useTransform(p, (v) => scrub01(v, 0.35, 0.85));
  const countOpacity = useTransform(p, (v) => scrub01(v, 0.7, 1));

  return (
    <div ref={ref} className="w-full max-w-[340px]" aria-hidden>
      <div className="flex flex-wrap gap-2">
        {["LinkedIn", "Gmail", "Calendar"].map((label, i) => (
          <motion.span
            key={label}
            className="flex items-center gap-1.5 rounded-full border border-[#e8f3f1]/[0.14] px-3 py-1 text-[11px] text-[#9aada8]"
            style={reduced ? undefined : chipStyles[i]}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[#c4a35a]" />
            {label}
          </motion.span>
        ))}
      </div>
      <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-[#e8f3f1]/10">
        <motion.div
          className="h-full w-[70%] origin-left rounded-full bg-[#c4a35a]/70"
          style={reduced ? undefined : { scaleX: barScale }}
        />
      </div>
      <motion.p
        className="mt-2 text-xs text-[#9aada8]"
        style={reduced ? undefined : { opacity: countOpacity }}
      >
        <span className="text-[#e8f3f1]">114 contacts</span> and counting
      </motion.p>
    </div>
  );
}
