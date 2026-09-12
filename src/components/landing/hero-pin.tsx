"use client";

import { forwardRef, useEffect, useRef, type ReactNode } from "react";
import { motion, useScroll, useTransform } from "motion/react";
import { scrub01 } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { LandingSolarSystem } from "@/components/landing/landing-visuals";
import { useIsLg } from "@/components/landing/use-is-lg";

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
  { text: "Still warm", r: 156, side: -1 },
  { text: "Drifting", r: 234, side: -1 },
];

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
export const HeroPin = forwardRef<
  HTMLElement,
  {
    heroCopy: ReactNode;
    claim: ReactNode;
  }
>(function HeroPin({ heroCopy, claim }, ref) {
  const wrapRef = useRef<HTMLElement | null>(null);
  const reduced = usePrefersReducedMotion();
  const isLg = useIsLg();

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
  // face-on; the system recenters onto measured targets — horizontally to
  // the frame's center (lg only), vertically centered in the space between
  // the claim copy and the frame bottom, shrinking below the max scale
  // whenever the full composition wouldn't fit the viewport.
  const CAM_SCALE_MAX = 0.68;
  // Below md the stage is capped by the column's width, not the frame's
  // height, so 0.68 left the flattened system floating in a lot of empty
  // space. Phones get a bigger share of what the pin already reserved.
  const CAM_SCALE_MAX_SM = 0.86;
  const CAM_SCALE_MIN = 0.42;
  const camTarget = useRef({ x: 0, y: 0, scale: CAM_SCALE_MAX });
  const camScale = useTransform(
    scrollYProgress,
    (v) => 1 - (1 - camTarget.current.scale) * scrub01(v, 0, 0.55)
  );
  const camX = useTransform(
    scrollYProgress,
    (v) => scrub01(v, 0.1, 0.55) * camTarget.current.x
  );
  const camY = useTransform(
    scrollYProgress,
    (v) => scrub01(v, 0.1, 0.55) * camTarget.current.y
  );
  const rotateX = useTransform(scrollYProgress, [0, 0.55], [REST_TILT_X, 0]);
  const rotateY = useTransform(scrollYProgress, [0, 0.55], [REST_TILT_Y, 0]);

  const frameRef = useRef<HTMLDivElement | null>(null);
  const camWrapRef = useRef<HTMLDivElement | null>(null);
  const claimRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const frame = frameRef.current;
    const el = camWrapRef.current;
    if (!frame || !el || reduced) return;
    const measure = () => {
      const frameRect = frame.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      // Subtract the scrub's current translation to recover the wrapper's
      // untransformed center (scale is about the center, so it cancels out).
      const cx = rect.left + rect.width / 2 - camX.get() - frameRect.left;
      const cy = rect.top + rect.height / 2 - camY.get() - frameRect.top;
      // Fit the flattened system into the space between the claim copy and
      // the frame bottom: offsetWidth is the untransformed stage width and
      // the outermost ring spans r/VIEW of it. Shrink the end scale until
      // the whole composition (plus label margins) fits, then center it in
      // the leftover space.
      const baseRingR =
        el.offsetWidth * (RING_LABELS[RING_LABELS.length - 1]!.r / SOLAR_VIEW);
      const claimBottom = claimRef.current
        ? claimRef.current.getBoundingClientRect().bottom - frameRect.top
        : frameRect.height * 0.3;
      const TOP_GAP = 24;
      const BOTTOM_PAD = 56; // room for the Drifting pill under the ring
      const avail = frameRect.height - claimBottom - TOP_GAP - BOTTOM_PAD;
      const scaleMax =
        frameRect.width < 768 ? CAM_SCALE_MAX_SM : CAM_SCALE_MAX;
      const scaleEnd = Math.min(
        scaleMax,
        Math.max(CAM_SCALE_MIN, avail / (2 * baseRingR))
      );
      const ringR = baseRingR * scaleEnd;
      const extra = Math.max(0, avail - 2 * ringR);
      camTarget.current = {
        x: frameRect.width / 2 - cx,
        y: claimBottom + TOP_GAP + extra / 2 + ringR - cy,
        scale: scaleEnd,
      };
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(frame);
    ro.observe(el);
    return () => ro.disconnect();
  }, [reduced, isLg, camX, camY]);

  // Beat 3 (p 0.45→0.84): cadence rings brighten, claim + labels arrive.
  const cadenceOpacity = useTransform(scrollYProgress, (v) => scrub01(v, 0.45, 0.7));
  const claimOpacity = useTransform(scrollYProgress, (v) => scrub01(v, 0.55, 0.75));
  const claimY = useTransform(scrollYProgress, [0.55, 0.75], [28, 0]);
  const labelOpacities = [
    useTransform(scrollYProgress, (v) => scrub01(v, 0.62, 0.72)),
    useTransform(scrollYProgress, (v) => scrub01(v, 0.68, 0.78)),
    useTransform(scrollYProgress, (v) => scrub01(v, 0.74, 0.84)),
  ];

  function setWrapRef(node: HTMLElement | null) {
    wrapRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  }

  return (
    <section ref={setWrapRef} className={reduced ? "relative" : "relative h-[260svh]"}>
      <div
        ref={frameRef}
        className={cn(
          "flex flex-col",
          reduced ? "min-h-svh" : "sticky top-0 h-svh overflow-hidden"
        )}
      >
        {/* Fixed header overlays the hero; reserve its height so copy/grid
         * stay vertically centered where they were when the header lived here. */}
        <div aria-hidden className="shrink-0 h-[4.5rem] md:h-[4.75rem]" />

        {/* py-4 below md: pt-2/pb-6 pushed the whole stack ~8px above centre,
          * which read as a top-heavy hero with dead space under the system. */}
        <main className="relative z-10 flex min-h-0 flex-1 flex-col justify-center px-8 py-4 md:px-10 md:pb-10 md:pt-4">
          <div className="mx-auto grid w-full max-w-6xl items-center gap-4 sm:gap-6 md:-translate-y-6 md:gap-10 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:gap-12">
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
              ref={camWrapRef}
              // Below md the stage is sized against the viewport, not the
              // column. The outermost orbit ring paints ~0.57 x the stage
              // from centre (Neptune at 234 of 440 view units, widened by the
              // resting tilt's perspective) and its planet art adds a few px
              // on top, so a column-width stage pushed the outer planets into
              // .landing-root's overflow-x-clip. 78vw keeps the whole system
              // on screen while still letting it bleed past the 32px gutter.
              // The svh term is what keeps it fitting on short viewports.
              className="relative mx-auto aspect-square w-[min(78vw,40svh,400px)] sm:w-[min(78vw,44svh,440px)] md:w-[min(100%,44svh,400px)] lg:mx-0 lg:w-full lg:max-w-[min(100%,560px)] lg:justify-self-end"
              style={
                reduced
                  ? undefined
                  : { scale: camScale, x: isLg ? camX : 0, y: camY }
              }
            >
              <LandingSolarSystem
                camera={reduced ? undefined : { rotateX, rotateY, cadenceOpacity }}
              />
              {!reduced && (
                <div aria-hidden className="pointer-events-none absolute inset-0 z-[3]">
                  {RING_LABELS.map((label, i) => (
                    <motion.span
                      key={label.text}
                      className="absolute left-1/2 inline-block -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#05070f]/70 px-2.5 py-1 text-[10px] uppercase tracking-[0.2em] text-[#f2c14e]"
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
            ref={claimRef}
            className="pointer-events-none absolute inset-x-0 top-[9svh] z-20 px-8 text-center md:px-6"
            style={{ opacity: claimOpacity, y: claimY }}
          >
            <div className="mx-auto max-w-2xl">{claim}</div>
          </motion.div>
        )}
      </div>

      {reduced && (
        <div className="relative z-10 px-8 py-24 text-center md:px-10">
          <div className="mx-auto max-w-2xl">{claim}</div>
        </div>
      )}
    </section>
  );
});
