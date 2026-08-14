"use client";

import { useRef, useSyncExternalStore } from "react";
import { motion, useScroll, useTransform } from "motion/react";
import { scrub01 } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { LandingSolarSystem } from "@/components/landing/landing-visuals";

/* Resting camera angle — keep in sync with BASE_TILT_X/Y in
 * hero-solar-system.tsx (not imported: a value import would pull the
 * lazy-loaded solar module into the main bundle). */
const REST_TILT_X = 28;
const REST_TILT_Y = -12;

/* Ring label geometry uses the solar stage's 440-unit viewBox (VIEW in
 * hero-solar-system.tsx); labels sit on the top or bottom point of each
 * ring (Steady orbit goes bottom so it clears the claim copy). */
const SOLAR_VIEW = 440;
const RING_LABELS = [
  { text: "Inner circle", r: 78, side: 1 },
  { text: "Steady orbit", r: 156, side: -1 },
  { text: "Drifting", r: 234, side: 1 },
];

function subscribeLg(cb: () => void) {
  const mq = window.matchMedia("(min-width: 1024px)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/**
 * Pin orchestrator for the hero → orbits scene. The wrapper spans 260svh;
 * a sticky frame holds the hero for ~1.6 viewports while scroll position
 * scrubs the transformation (native scroll only — nothing is hijacked).
 *
 * Scroll-linked style bindings are NOT animations, so neither the global
 * reduced-motion CSS clamp nor MotionConfig touches them — this component
 * is the single reduced-motion gate for the scene: reduced ⇒ no pin, no
 * bindings, static composition with the claim as a normal flow section.
 */
export function HeroPin({
  header,
  heroCopy,
  claim,
}: {
  header: React.ReactNode;
  heroCopy: React.ReactNode;
  claim: React.ReactNode;
}) {
  const wrapRef = useRef<HTMLElement | null>(null);
  const reduced = usePrefersReducedMotion();
  const isLg = useSyncExternalStore(
    subscribeLg,
    () => window.matchMedia("(min-width: 1024px)").matches,
    () => false
  );

  // Hooks run unconditionally; `reduced` gates the *bindings* below.
  const { scrollYProgress } = useScroll({
    target: wrapRef,
    offset: ["start start", "end end"],
  });

  // Opacity scrubs are function transforms on scrub01 — see its doc
  // comment for why range maps must not be used for opacity here.

  // Beat 1 (p 0→0.25): hero copy exits.
  const copyOpacity = useTransform(scrollYProgress, (v) => 1 - scrub01(v, 0, 0.25));
  const copyY = useTransform(scrollYProgress, [0, 0.25], [0, -32]);
  const copyPointer = useTransform(copyOpacity, (o) =>
    o < 0.4 ? ("none" as const) : ("auto" as const)
  );

  // Beat 2 (p 0→0.55): camera pulls back and the ecliptic flattens
  // face-on; on lg the system recenters from the right column.
  const camScale = useTransform(scrollYProgress, [0, 0.55], [1, 0.68]);
  const camX = useTransform(scrollYProgress, [0.1, 0.55], ["0%", "-48%"]);
  const rotateX = useTransform(scrollYProgress, [0, 0.55], [REST_TILT_X, 0]);
  const rotateY = useTransform(scrollYProgress, [0, 0.55], [REST_TILT_Y, 0]);

  // Beat 3 (p 0.45→0.84): cadence rings brighten, claim + labels arrive.
  const cadenceOpacity = useTransform(scrollYProgress, (v) => scrub01(v, 0.45, 0.7));
  const claimOpacity = useTransform(scrollYProgress, (v) => scrub01(v, 0.55, 0.75));
  const claimY = useTransform(scrollYProgress, [0.55, 0.75], [28, 0]);
  const labelOpacities = [
    useTransform(scrollYProgress, (v) => scrub01(v, 0.62, 0.72)),
    useTransform(scrollYProgress, (v) => scrub01(v, 0.68, 0.78)),
    useTransform(scrollYProgress, (v) => scrub01(v, 0.74, 0.84)),
  ];

  return (
    <section ref={wrapRef} className={reduced ? "relative" : "relative h-[260svh]"}>
      <div
        className={cn(
          "flex flex-col",
          reduced ? "min-h-svh" : "sticky top-0 h-svh overflow-hidden"
        )}
      >
        {header}

        <main className="relative z-10 flex flex-1 flex-col justify-center px-6 pb-8 pt-4 md:px-10 md:pb-10">
          <div className="mx-auto grid w-full max-w-6xl items-center gap-10 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:gap-12">
            <motion.div
              className="max-w-3xl"
              style={
                reduced
                  ? undefined
                  : { opacity: copyOpacity, y: copyY, pointerEvents: copyPointer }
              }
            >
              {heroCopy}
            </motion.div>

            <motion.div
              className="relative mx-auto w-full max-w-[min(100%,560px)] lg:mx-0 lg:justify-self-end"
              style={reduced ? undefined : { scale: camScale, x: isLg ? camX : 0 }}
            >
              <LandingSolarSystem
                camera={reduced ? undefined : { rotateX, rotateY, cadenceOpacity }}
              />
              {!reduced && (
                <div aria-hidden className="pointer-events-none absolute inset-0 z-[3]">
                  {RING_LABELS.map((label, i) => (
                    <motion.span
                      key={label.text}
                      className="absolute left-1/2 inline-block -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#05070f]/70 px-2.5 py-1 text-[10px] uppercase tracking-[0.2em] text-[#c4a35a]"
                      style={{
                        top: `${50 - label.side * (label.r / SOLAR_VIEW) * 100}%`,
                        opacity: labelOpacities[i],
                      }}
                    >
                      {label.text}
                    </motion.span>
                  ))}
                </div>
              )}
            </motion.div>
          </div>
        </main>

        {!reduced && (
          <motion.div
            className="pointer-events-none absolute inset-x-0 top-[12svh] z-20 px-6 text-center"
            style={{ opacity: claimOpacity, y: claimY }}
          >
            <div className="mx-auto max-w-2xl">{claim}</div>
          </motion.div>
        )}
      </div>

      {reduced && (
        <div className="relative z-10 px-6 py-24 text-center md:px-10">
          <div className="mx-auto max-w-2xl">{claim}</div>
        </div>
      )}
    </section>
  );
}
