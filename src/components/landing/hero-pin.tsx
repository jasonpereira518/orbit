"use client";

import { forwardRef, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { motion, useMotionValueEvent, useScroll, useTransform } from "motion/react";
import { scrub01 } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import {
  BEATS,
  DEFAULT_STOP,
  LAST_TALKED_STOPS,
  PIN_SVH,
  RINGS,
  RING_VERDICTS,
  WORLDS,
  projectToFrame,
  radiusForDays,
  ringForDays,
} from "@/components/landing/hero-choreography";

/* Nothing here may value-import hero-scene.ts: that would put three in the landing page's
 * first load. The scene arrives through the `import()` below; shared numbers come from
 * hero-choreography.ts. */

const POSTER = "/landing/hero/poster";
/** The overhead still's scroll position and shape (scripts/dev/capture-landing.mjs). */
const RINGS_STILL = { p: 0.5, aspect: 1 };

let webglSupport: boolean | null = null;
function hasWebGL2() {
  if (webglSupport !== null) return webglSupport;
  try {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2");
    webglSupport = Boolean(gl);
    // A live context counts against the browser's small per-page cap until GC finds the
    // probe; the answer is all this needed.
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    webglSupport = false;
  }
  return webglSupport;
}

/** Devices that get the still instead of the scene: no WebGL2, data saver, very little memory. */
function wantsStill() {
  const nav = navigator as Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number };
  return !hasWebGL2() || nav.connection?.saveData === true || (nav.deviceMemory ?? 8) <= 2;
}

/** The answer never changes while the page is open, so there is nothing to subscribe to. */
const subscribeNever = () => () => {};

/**
 * The hero's first frame as a picture: the page's LCP, painted before any script runs, and
 * what stays on screen when the scene never mounts or loses its context.
 */
function Poster() {
  return (
    <picture>
      <source media="(max-width: 767px)" type="image/avif" srcSet={`${POSTER}-tall-v1-780.avif`} />
      <source media="(max-width: 767px)" type="image/webp" srcSet={`${POSTER}-tall-v1-780.webp`} />
      <source
        type="image/avif"
        srcSet={`${POSTER}-wide-v1-1280.avif 1280w, ${POSTER}-wide-v1-2560.avif 2560w`}
        sizes="100vw"
      />
      <source
        type="image/webp"
        srcSet={`${POSTER}-wide-v1-1280.webp 1280w, ${POSTER}-wide-v1-2560.webp 2560w`}
        sizes="100vw"
      />
      <img
        src={`${POSTER}-wide-v1-1280.webp`}
        alt=""
        fetchPriority="high"
        decoding="async"
        className="absolute inset-0 size-full object-cover"
      />
    </picture>
  );
}

/**
 * A ring's name, and its threshold where there is room for it. On a narrow frame the system
 * is about 270px across and a two-line chip covers the worlds beside it, so there the note
 * is left to the claim's own sentence and the slider's result line, which both say it.
 */
function RingLabel({ name, note, full = false }: { name: string; note: string; full?: boolean }) {
  return (
    <span className="block -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-[#03050c]/75 px-3 py-1 text-center">
      <span className="block font-[family-name:var(--font-display)] text-sm leading-tight text-[#f2c14e]">{name}</span>
      <span className={cn("text-xs leading-tight text-[#9aada8]", full ? "block" : "hidden split:block")}>{note}</span>
    </span>
  );
}

/**
 * The slider: pick how long ago you last talked to someone, and their world moves to the
 * ring Orbit would put them in. The thresholds are the product's own (hero-choreography.ts).
 */
function LastTalked({
  stop,
  onStop,
  className,
}: {
  stop: number;
  onStop: (stop: number) => void;
  className?: string;
}) {
  const id = useId();
  const { label, days } = LAST_TALKED_STOPS[stop];
  const verdict = RING_VERDICTS[ringForDays(days)];
  return (
    <div className={cn("flex w-full max-w-sm flex-col items-start text-left", className)}>
      <label htmlFor={id} className="text-sm text-[#e8f3f1]">
        Pick someone you know. When did you last talk?
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={LAST_TALKED_STOPS.length - 1}
        step={1}
        value={stop}
        onChange={(e) => onStop(Number(e.target.value))}
        aria-valuetext={`${label}. ${verdict}`}
        className="mt-1 h-11 w-full cursor-pointer rounded-full accent-[#f2c14e] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f2c14e]"
      />
      <output htmlFor={id} className="text-sm text-[#9aada8]">
        <span className="inline-block text-[#f2c14e] first-letter:uppercase">{label}.</span> {verdict}
      </output>
    </div>
  );
}

/**
 * The hero: one WebGL scene pinned for PIN_SVH and scrubbed by native scroll through three
 * beats (the star and its worlds, the system from overhead, the comet), with the copy, the
 * ring labels and the slider laid over it as DOM.
 *
 * Scroll-linked style bindings are not animations, so neither the reduced-motion CSS clamp
 * nor MotionConfig touches them: this component is the scene's single gate. Reduced motion,
 * or a device that should not run the scene, gets no pin and no bindings: the stills, with
 * the three blocks of copy in normal flow.
 */
export const HeroPin = forwardRef<
  HTMLElement,
  { heroCopy: ReactNode; claim: ReactNode; cometClaim: ReactNode }
>(function HeroPin({ heroCopy, claim, cometClaim }, ref) {
  const wrapRef = useRef<HTMLElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const ringRefs = useRef<(HTMLDivElement | null)[]>([]);
  const liveRef = useRef<HTMLDivElement | null>(null);
  const reduced = usePrefersReducedMotion();
  // False on the server and while hydrating, like the reduced-motion preference: the
  // server renders the pin, and a device that should not run the scene swaps to the stills.
  const still = useSyncExternalStore(subscribeNever, wantsStill, () => false);
  const [ready, setReady] = useState(false);
  const [beat, setBeat] = useState(0);
  const [stop, setStop] = useState<number>(DEFAULT_STOP);
  const days = useRef<number>(LAST_TALKED_STOPS[DEFAULT_STOP].days);
  const isStatic = reduced || still;

  const { scrollYProgress } = useScroll({ target: wrapRef, offset: ["start start", "end end"] });

  // Opacity scrubs are function transforms on scrub01: see its doc comment for why range
  // maps must not be used for opacity inside a sticky pin.
  const copyOpacity = useTransform(scrollYProgress, (v) => 1 - scrub01(v, ...BEATS.copyOut));
  const copyY = useTransform(scrollYProgress, [...BEATS.copyOut], [0, -28]);
  const systemOpacity = useTransform(
    scrollYProgress,
    (v) => scrub01(v, ...BEATS.systemIn) * (1 - scrub01(v, ...BEATS.systemOut)),
  );
  const systemY = useTransform(scrollYProgress, [...BEATS.systemIn], [20, 0]);
  const cometOpacity = useTransform(scrollYProgress, (v) => scrub01(v, ...BEATS.cometIn));
  const cometY = useTransform(scrollYProgress, [...BEATS.cometIn], [20, 0]);

  // Which block can be used: the others are `inert`, so the slider is never an invisible
  // tab stop and the hero's buttons cannot be pressed through a faded layer. Re-renders
  // only when the beat changes, three times across the whole pin.
  useMotionValueEvent(scrollYProgress, "change", (v) => {
    const next = v < BEATS.copyOut[1] ? 0 : v < BEATS.systemOut[1] ? 1 : 2;
    setBeat((current) => (current === next ? current : next));
  });

  useEffect(() => {
    const host = hostRef.current;
    if (isStatic || !host) return;
    let dispose = () => {};
    let cancelled = false;
    const start = () => {
      void import("@/components/landing/hero-scene").then(({ mountHeroScene }) => {
        if (cancelled) return;
        dispose = mountHeroScene(host, {
          progress: () => scrollYProgress.get(),
          liveDays: () => days.current,
          anchors: { rings: ringRefs.current, live: liveRef.current },
          light: window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 768,
          onReady: () => setReady(true),
          onLost: (lost) => setReady(!lost),
        });
      });
    };
    // After the page has settled: the poster is already up, and the scene's chunk and
    // textures should not compete with the first paint.
    const idle = window.requestIdleCallback?.(start, { timeout: 1500 });
    const timer = idle === undefined ? window.setTimeout(start, 300) : 0;
    return () => {
      cancelled = true;
      if (idle !== undefined) window.cancelIdleCallback(idle);
      window.clearTimeout(timer);
      dispose();
      setReady(false);
    };
  }, [isStatic, scrollYProgress]);

  const pickStop = (next: number) => {
    days.current = LAST_TALKED_STOPS[next].days;
    setStop(next);
  };

  function setWrapRef(node: HTMLElement | null) {
    wrapRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  }

  if (isStatic) {
    const live = WORLDS.find((world) => world.live)!;
    const radius = radiusForDays(LAST_TALKED_STOPS[stop].days);
    const at = (x: number, z: number) => {
      const point = projectToFrame(RINGS_STILL.p, RINGS_STILL.aspect, [x, 0, z], "still");
      return { left: `${point.x * 100}%`, top: `${point.y * 100}%` };
    };
    return (
      <section ref={setWrapRef} className="relative">
        <div className="relative flex min-h-svh flex-col justify-end overflow-hidden">
          <Poster />
          <div aria-hidden className="absolute inset-0 bg-[linear-gradient(to_top,rgba(3,5,12,0.9),rgba(3,5,12,0)_60%)]" />
          <div className="relative px-8 pb-[11svh] pt-28 max-md:pb-[calc(6.5rem+env(safe-area-inset-bottom))] md:px-10">
            <div className="mx-auto w-full max-w-6xl">
              {heroCopy}
            </div>
          </div>
        </div>

        <div className="relative z-10 px-8 py-24 md:px-10">
          <div className="mx-auto grid w-full max-w-6xl items-center gap-10 lg:grid-cols-2">
            <div>
              <div className="max-w-md">{claim}</div>
              <div className="mt-8">
                <LastTalked stop={stop} onStop={pickStop} />
              </div>
            </div>
            {/* The still dissolves at its edge (a round mask), like every other picture on
              * the page: a boxed square would be the one card with a corner radius. */}
            <div className="relative mx-auto aspect-square w-full max-w-xl">
              <picture>
                <source type="image/avif" srcSet={`${POSTER}-rings-v1-1200.avif`} />
                <img
                  src={`${POSTER}-rings-v1-1200.webp`}
                  alt="A star with three orbits around it and eight worlds on them, seen from above."
                  loading="lazy"
                  decoding="async"
                  className="absolute inset-0 size-full object-cover [mask-image:radial-gradient(circle_at_center,black_58%,transparent_72%)]"
                />
              </picture>
              {RINGS.map((ring) => (
                <div key={ring.id} className="absolute" style={at(0, -ring.side * ring.r)}>
                  <RingLabel name={ring.name} note={ring.note} full />
                </div>
              ))}
              <span
                aria-hidden
                className="absolute block size-8 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#f2c14e]"
                style={at(radius * Math.cos(live.phase), radius * Math.sin(live.phase))}
              />
            </div>
          </div>
        </div>

        <div className="relative z-10 px-8 pb-24 md:px-10">
          <div className="mx-auto w-full max-w-6xl">
            <div className="max-w-md">{cometClaim}</div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section ref={setWrapRef} data-hero-pin className="relative" style={{ height: `${PIN_SVH}svh` }}>
      {/* Without script nothing scrubs, so the two later blocks would stay at opacity 0
        * inside a pin four screens tall. Unpin and show all three in order instead. */}
      <noscript>
        <style>{`[data-hero-pin]{height:auto!important}[data-hero-frame]{position:relative!important;height:auto!important}[data-hero-layer]{position:relative!important;inset:auto!important;opacity:1!important;transform:none!important;padding-block:5rem}[data-hero-js]{display:none!important}`}</style>
      </noscript>
      <div data-hero-frame className="sticky top-0 h-svh overflow-hidden">
        {/* The scene has its own sky; the page below has the starfield's. The mask lets the
          * frame's last stretch dissolve into that, so the pin ends without a line. */}
        <div aria-hidden className="absolute inset-0 [mask-image:linear-gradient(to_bottom,black_86%,transparent)]">
          <Poster />
          <div
            ref={hostRef}
            className={cn(
              "absolute inset-0 transition-opacity duration-700 ease-out",
              ready ? "opacity-100" : "opacity-0",
            )}
          />
        </div>

        <motion.div
          data-hero-layer
          inert={beat !== 0}
          className="absolute inset-0 flex flex-col justify-end"
          style={{ opacity: copyOpacity, y: copyY }}
        >
          {/* A scrim, not a decoration: the copy has to read over a star map. */}
          <div aria-hidden className="absolute inset-0 bg-[linear-gradient(to_top,rgba(3,5,12,0.9),rgba(3,5,12,0)_60%)]" />
          <div className="relative px-8 pb-[11svh] max-md:pb-[calc(6.5rem+env(safe-area-inset-bottom))] md:px-10">
            <div className="mx-auto w-full max-w-6xl">
              {heroCopy}
            </div>
          </div>
        </motion.div>

        <motion.div
          data-hero-layer
          inert={beat !== 1}
          className="absolute inset-0"
          style={{ opacity: systemOpacity }}
        >
          {/* Stacked: the claim above the system and the slider below it. Side by side
            * (`split:`, the same test the scene makes): the claim and the slider take the left,
            * the system the right. Left-aligned either way, on the page's one left edge. */}
          <motion.div
            className="absolute inset-x-0 top-[11svh] px-8 split:top-[24svh] md:px-10"
            style={{ y: systemY }}
          >
            <div className="mx-auto w-full max-w-6xl">
              <div className="max-w-md">{claim}</div>
            </div>
          </motion.div>
          {/* Positioned by the scene, which projects each ring's label point every frame. */}
          <div data-hero-js aria-hidden>
            {RINGS.map((ring, i) => (
              <div
                key={ring.id}
                ref={(node) => {
                  ringRefs.current[i] = node;
                }}
                className="absolute left-0 top-0 will-change-transform"
              >
                <RingLabel name={ring.name} note={ring.note} />
              </div>
            ))}
            <div ref={liveRef} className="absolute left-0 top-0 will-change-transform">
              <span className="block size-10 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#f2c14e]" />
            </div>
          </div>
          <div
            data-hero-js
            className="absolute inset-x-0 bottom-[6svh] px-8 max-md:bottom-[calc(5.5rem+env(safe-area-inset-bottom))] split:bottom-auto split:top-[60svh] md:px-10"
          >
            <div className="mx-auto w-full max-w-6xl">
              <LastTalked stop={stop} onStop={pickStop} />
            </div>
          </div>
        </motion.div>

        <motion.div
          data-hero-layer
          inert={beat !== 2}
          className="absolute inset-0"
          style={{ opacity: cometOpacity }}
        >
          <motion.div className="absolute inset-x-0 top-[16svh] px-8 md:px-10" style={{ y: cometY }}>
            <div className="mx-auto w-full max-w-6xl">
              <div className="max-w-md">{cometClaim}</div>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
});
