"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import type { TourHotspot } from "@/components/onboarding/tour-config";
import { cn } from "@/lib/utils";

type Point = { x: number; y: number };

type TourCursorProps = {
  containerRef: RefObject<HTMLElement | null>;
  hotspots: TourHotspot[];
  /** Step progress 0–1; drives which hotspot is active. */
  progress: number;
  playing: boolean;
  reducedMotion: boolean;
  /** When true (e.g. start step), cycle hotspots on a timer instead of progress. */
  freeCycle?: boolean;
};

const CYCLE_MS = 2800;
const MEASURE_INTERVAL_MS = 100;
const APPEAR_DELAY_MS = 380;

function pickHotspotIndex(
  count: number,
  progress: number,
  freeCycle: boolean,
  cycleTick: number
) {
  if (count <= 0) return 0;
  if (freeCycle) return cycleTick % count;
  const t = Math.min(0.999, Math.max(0, progress));
  return Math.min(count - 1, Math.floor(t * count));
}

function measureHotspot(container: HTMLElement, id: string): Point | null {
  const el = container.querySelector<HTMLElement>(
    `[data-tour-hotspot="${id}"]`
  );
  if (!el) return null;

  const c = container.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return {
    x: r.left - c.left + r.width * 0.55,
    y: r.top - c.top + r.height * 0.45,
  };
}

export function TourCursor({
  containerRef,
  hotspots,
  progress,
  playing,
  reducedMotion,
  freeCycle = false,
}: TourCursorProps) {
  const [cycleTick, setCycleTick] = useState(0);
  const [point, setPoint] = useState<Point | null>(null);
  const [visible, setVisible] = useState(false);
  const lastId = useRef<string | null>(null);

  const activeIndex = pickHotspotIndex(
    hotspots.length,
    progress,
    freeCycle,
    cycleTick
  );
  const active = hotspots[activeIndex] ?? null;

  // Free-cycle for start step (no auto-advance progress bar)
  useEffect(() => {
    if (!freeCycle || reducedMotion || !playing || hotspots.length === 0) {
      return;
    }
    const id = window.setInterval(() => {
      setCycleTick((t) => t + 1);
    }, CYCLE_MS);
    return () => window.clearInterval(id);
  }, [freeCycle, reducedMotion, playing, hotspots.length]);

  // Reset when hotspots change (new step)
  useEffect(() => {
    setCycleTick(0);
    setVisible(false);
    setPoint(null);
    lastId.current = null;

    const appear = window.setTimeout(() => setVisible(true), APPEAR_DELAY_MS);
    return () => window.clearTimeout(appear);
  }, [hotspots]);

  useLayoutEffect(() => {
    if (reducedMotion || !active || !visible) {
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    const update = () => {
      const next = measureHotspot(container, active.id);
      if (!next) return;

      setPoint((prev) => {
        if (
          prev &&
          lastId.current === active.id &&
          Math.abs(prev.x - next.x) < 1 &&
          Math.abs(prev.y - next.y) < 1
        ) {
          return prev;
        }
        return next;
      });
      lastId.current = active.id;
    };

    update();
    const interval = window.setInterval(update, MEASURE_INTERVAL_MS);
    window.addEventListener("resize", update);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("resize", update);
    };
  }, [active, containerRef, reducedMotion, progress, cycleTick, visible]);

  if (reducedMotion || !active || !point || !visible) return null;

  const container = containerRef.current;
  const cw = container?.clientWidth ?? 400;
  const ch = container?.clientHeight ?? 300;
  const bubbleRight = point.x > cw * 0.55;
  const bubbleBelow = point.y < ch * 0.38;

  const bubbleLeft = bubbleRight ? point.x - 18 : point.x + 26;
  const bubbleTop = bubbleBelow ? point.y + 30 : point.y - 58;

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20"
      aria-hidden
    >
      {/* Soft highlight ring */}
      <motion.div
        className="absolute h-9 w-9 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary/45 bg-primary/10"
        animate={{
          left: point.x,
          top: point.y,
          scale: [1, 1.18, 1],
          opacity: [0.5, 0.85, 0.5],
        }}
        transition={{
          left: { type: "spring", stiffness: 170, damping: 22 },
          top: { type: "spring", stiffness: 170, damping: 22 },
          scale: { duration: 1.7, repeat: Infinity, ease: "easeInOut" },
          opacity: { duration: 1.7, repeat: Infinity, ease: "easeInOut" },
        }}
      />

      {/* Cursor with a little hover drift */}
      <motion.div
        className="absolute"
        animate={{ left: point.x, top: point.y }}
        transition={{ type: "spring", stiffness: 150, damping: 20 }}
      >
        <motion.div
          animate={
            playing
              ? { x: [2, 5, 1, 4, 2], y: [2, 0, 4, 1, 2] }
              : { x: 2, y: 2 }
          }
          transition={
            playing
              ? { duration: 2.4, repeat: Infinity, ease: "easeInOut" }
              : { duration: 0.2 }
          }
        >
          <CursorGlyph />
        </motion.div>
      </motion.div>

      {/* Chat bubble */}
      <AnimatePresence mode="wait">
        <motion.div
          key={active.id}
          className={cn(
            "absolute w-max max-w-[11.5rem] rounded-2xl border border-border/80 bg-card px-3 py-2 text-left shadow-lg shadow-black/10",
            bubbleRight && "-translate-x-full"
          )}
          style={{ left: bubbleLeft, top: bubbleTop }}
          initial={{ opacity: 0, scale: 0.88, y: bubbleBelow ? -6 : 6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.92, transition: { duration: 0.15 } }}
          transition={{
            opacity: { duration: 0.2 },
            scale: { type: "spring", stiffness: 320, damping: 24 },
          }}
        >
          <p className="text-[12px] leading-snug text-foreground">
            {active.label}
          </p>
          <span
            className={cn(
              "absolute h-2.5 w-2.5 rotate-45 border-border/80 bg-card",
              bubbleBelow
                ? bubbleRight
                  ? "right-4 -top-1 border-l border-t"
                  : "left-4 -top-1 border-l border-t"
                : bubbleRight
                  ? "right-4 -bottom-1 border-b border-r"
                  : "left-4 -bottom-1 border-b border-r"
            )}
          />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function CursorGlyph() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      className="drop-shadow-[0_1px_2px_rgba(0,0,0,0.35)]"
    >
      <path
        d="M5.5 3.5 18.2 12.1l-5.4 1.4 2.6 6.4-2.4 1-2.7-6.5-4.2 3.7V3.5Z"
        fill="var(--primary)"
        stroke="var(--background)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}
