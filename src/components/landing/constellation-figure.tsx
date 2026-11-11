"use client";

import { useRef } from "react";
import { motion, useScroll, useTransform, type MotionValue } from "motion/react";
import { scrub01 } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/** The photograph's own pixel grid (`/landing/photos/orion-*`, Akira Fujii). */
const VIEW_W = 4039;
const VIEW_H = 3177;

/**
 * Where the real stars sit in the photograph, in its pixels. Measured from the image, not
 * from a catalogue: the lines have to land on the stars as this lens drew them. If the
 * photograph is ever replaced or re-cropped, these go with it.
 */
const STARS = {
  betelgeuse: [2948, 1012],
  bellatrix: [3404, 1112],
  meissa: [3272, 888],
  alnitak: [3096, 1584],
  alnilam: [3172, 1548],
  mintaka: [3240, 1508],
  saiph: [2932, 2020],
  rigel: [3456, 2016],
  sirius: [2072, 2304],
  mirzam: [2372, 2428],
  wezen: [1692, 2868],
  adhara: [1804, 3044],
  procyon: [1436, 980],
  gomeisa: [1632, 820],
} as const;
type Star = keyof typeof STARS;

type Label = { at: [number, number]; anchor: "start" | "end" };
/**
 * Three real constellations, each standing for one group of people. The group names and
 * counts are sample data. `phone` is the label's place when the plate is cropped to its
 * right-hand side; a figure without one falls outside that crop and is not drawn there.
 */
const FIGURES: { id: string; name: string; count: string; chains: Star[][]; wide: Label; phone?: Label }[] = [
  {
    id: "orion",
    name: "Stripe",
    count: "6 people you know",
    chains: [
      ["meissa", "betelgeuse", "alnitak", "saiph", "rigel", "mintaka", "bellatrix", "meissa"],
      ["alnitak", "alnilam", "mintaka"],
      ["betelgeuse", "bellatrix"],
    ],
    wide: { at: [3560, 1500], anchor: "start" },
    phone: { at: [3990, 2330], anchor: "end" },
  },
  {
    id: "canis-major",
    name: "UNC",
    count: "41 people you know",
    chains: [["mirzam", "sirius", "wezen", "adhara"]],
    wide: { at: [2200, 2230], anchor: "start" },
    phone: { at: [2200, 2700], anchor: "start" },
  },
  {
    id: "canis-minor",
    name: "Summer internship",
    count: "9 people you know",
    chains: [["procyon", "gomeisa"]],
    wide: { at: [1700, 760], anchor: "start" },
  },
];

const pathOf = (chain: Star[]) => chain.map((star, i) => `${i ? "L" : "M"}${STARS[star][0]} ${STARS[star][1]}`).join(" ");

function Chain({ d, progress, from, reduced }: { d: string; progress: MotionValue<number>; from: number; reduced: boolean }) {
  const drawn = useTransform(progress, (v) => scrub01(v, from, from + 0.42));
  return (
    <motion.path
      d={d}
      fill="none"
      stroke="rgba(242,193,78,0.85)"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
      style={{ pathLength: reduced ? 1 : drawn }}
    />
  );
}

function FigureLabel({
  name,
  count,
  label,
  size,
  progress,
  from,
  reduced,
}: {
  name: string;
  count: string;
  label: Label;
  size: number;
  progress: MotionValue<number>;
  from: number;
  reduced: boolean;
}) {
  const shown = useTransform(progress, (v) => scrub01(v, from, from + 0.14));
  return (
    // A dark edge under each letter (stroke painted first): the labels sit on a field of
    // stars, and a star behind a thin stroke takes the letter with it.
    <motion.g
      style={{ opacity: reduced ? 1 : shown }}
      textAnchor={label.anchor}
      stroke="#03050c"
      strokeWidth={size * 0.16}
      strokeLinejoin="round"
      paintOrder="stroke"
    >
      <text x={label.at[0]} y={label.at[1]} fontSize={size} fill="#e8f3f1" style={{ fontFamily: "var(--font-display)" }}>
        {name}
      </text>
      <text x={label.at[0]} y={label.at[1] + size * 1.2} fontSize={size * 0.68} fill="#c9d6d2">
        {count}
      </text>
    </motion.g>
  );
}

/**
 * The lines of three constellations, drawn over the photograph of them as the section
 * scrolls in: scrubbed, so they retrace on the way back. Lay it over the photograph in the
 * same box, with the photograph `object-cover` and positioned to match `anchor` ("center"
 * with `object-center`, "right" with `object-right`): the viewBox is the photograph's pixel
 * grid and `slice` crops it exactly as `object-cover` crops the image.
 *
 * Decorative: the section's paragraph carries the claim. This component is its own
 * reduced-motion gate (a scroll-linked binding is not an animation the global clamp sees).
 */
export function ConstellationFigure({ anchor, labelSize }: { anchor: "center" | "right"; labelSize: number }) {
  // A div, not the svg: useScroll's target is typed for HTML elements.
  const ref = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  // Finished by the time the section's top is a third of the way down the viewport: that
  // is where it is read, and a label still fading in there is a label at half contrast.
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 0.9", "start 0.35"] });
  const figures = FIGURES.filter((figure) => anchor === "center" || figure.phone);
  // Each figure starts drawing where the one before it left off.
  const starts = figures.map((_, i) => figures.slice(0, i).reduce((n, figure) => n + figure.chains.length, 0));
  return (
    <div ref={ref} aria-hidden className="absolute inset-0">
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio={anchor === "center" ? "xMidYMid slice" : "xMaxYMid slice"}
      className="size-full"
    >
      {figures.map((figure, n) => {
        const first = starts[n];
        return (
          <g key={figure.id}>
            {figure.chains.map((chain, i) => (
              <Chain key={i} d={pathOf(chain)} progress={scrollYProgress} from={(first + i) * 0.11} reduced={reduced} />
            ))}
            <FigureLabel
              name={figure.name}
              count={figure.count}
              label={anchor === "center" ? figure.wide : figure.phone!}
              size={labelSize}
              progress={scrollYProgress}
              from={(first + figure.chains.length - 1) * 0.11 + 0.3}
              reduced={reduced}
            />
          </g>
        );
      })}
    </svg>
    </div>
  );
}
