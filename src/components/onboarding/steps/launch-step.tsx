"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { motion, useReducedMotionConfig } from "motion/react";
import { startInAppTour } from "@/actions/tour";
import { OrbitLogo } from "@/components/orbit-logo";
import { Button } from "@/components/ui/button";
import { Stagger, StaggerItem, StepHeading } from "@/components/onboarding/onboarding-ui";
import { friendlyError } from "@/lib/errors";

/**
 * The last stage step on the tour path. It runs the handoff on arrival — one server action
 * that stamps the gate flag, opens the tour and plants the example people — then sends the
 * person to the dashboard, where the coach rail picks them up. A failed seed is not a
 * failed tour: the retry and the "anyway" button both exist so nobody is stranded here.
 */
/**
 * How long the stage holds at least, so the animation reads as a moment rather than a flash
 * (the action itself often lands in well under a second). The bar is paced to this.
 */
const HOLD_MS = 3600;
/** The last stretch: the bar finishes filling before the page moves on. */
const FINISH_MS = 380;

export function LaunchStep() {
  const [state, setState] = useState<{ phase: "working" | "done" | "failed"; error?: string }>({
    phase: "working",
  });
  const [attemptKey, setAttemptKey] = useState(0);
  const attempt = useRef(0);

  // The retry button's own handler: it may flip state synchronously before starting again.
  const launch = () => {
    setState({ phase: "working" });
    setAttemptKey((k) => k + 1);
    run();
  };

  // Only the async callbacks below touch state, which is what keeps the mount effect from
  // calling setState synchronously during render.
  const run = () => {
    const mine = ++attempt.current;
    const hold = new Promise((resolve) => window.setTimeout(resolve, HOLD_MS));
    Promise.all([startInAppTour(), hold])
      .then(([res]) => {
        if (mine !== attempt.current) return;
        setState({ phase: "done" });
        // A full load that replaces this entry: the action revalidates (its response can
        // snap a client push back here), and Back from the dashboard should not restore a
        // cached stage mid-tour. The server sends a stale /onboarding on to the dashboard.
        window.setTimeout(() => window.location.replace(res.redirectTo), FINISH_MS);
      })
      .catch((err) => {
        if (mine !== attempt.current) return;
        setState({
          phase: "failed",
          error: friendlyError(err, "Couldn’t set the stage — the tour still works with an empty orbit"),
        });
      });
  };

  // Runs once on arrival. The action is idempotent, so a React strict-mode double mount
  // costs a second no-op write, not a second tour.
  useEffect(() => {
    run();
  }, []);

  return (
    <Stagger className="mx-auto flex max-w-lg flex-col items-center text-center">
      <StaggerItem className="relative mb-7 flex size-28 items-center justify-center">
        <span aria-hidden className="absolute inset-0 rounded-full border border-primary/20" />
        <span
          aria-hidden
          className="absolute inset-0 animate-[interest-orbit_6s_linear_infinite] rounded-full"
        >
          <span className="absolute -top-1 left-1/2 size-2 -translate-x-1/2 rounded-full bg-primary" />
        </span>
        <OrbitLogo size="xl" />
      </StaggerItem>
      <StepHeading eyebrow="Almost there" title="Setting the stage" className="text-center">
        Orbit is adding six example people so every page has something to show. They’re clearly
        marked and disappear when the tour ends.
      </StepHeading>
      {state.phase === "failed" && (
        <StaggerItem className="mt-6 space-y-3">
          <p className="text-sm text-warning" role="status">
            {state.error}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button type="button" onClick={launch}>
              Try again
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => window.location.replace("/dashboard")}
            >
              Start the tour anyway
              <ArrowRight className="size-4" aria-hidden />
            </Button>
          </div>
        </StaggerItem>
      )}
      {state.phase !== "failed" && (
        <StaggerItem className="mt-7 w-full max-w-md space-y-3">
          <LaunchProgress key={attemptKey} done={state.phase === "done"} />
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {state.phase === "done" ? "Ready. Opening your dashboard…" : "Adding the example people…"}
          </p>
        </StaggerItem>
      )}
    </Stagger>
  );
}

/** Bubbles riding the bar: size in px, how long one ride takes, and when it first sets off. */
const BUBBLES = [
  { size: 6, duration: 1.1, delay: 0 },
  { size: 4, duration: 0.8, delay: 0.35 },
  { size: 5, duration: 0.95, delay: 0.6 },
  { size: 3, duration: 0.7, delay: 0.15 },
  { size: 4, duration: 0.85, delay: 0.8 },
];

/**
 * A progress bar that is honest about being a pace, not a measurement: it accelerates towards
 * nine-tenths over the hold (an ease-in, so it looks like it is picking up speed), then snaps
 * full when the work is actually done. Bubbles ride the filled part left to right, faster than
 * the fill, so it always looks busy. Reduced motion: the fill still moves (it is the only
 * sign of progress), without the bubbles or the shimmer.
 */
function LaunchProgress({ done }: { done: boolean }) {
  const reduced = useReducedMotionConfig();
  return (
    <div
      role="progressbar"
      aria-label="Setting the stage"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={done ? 100 : undefined}
      className="relative h-2.5 w-full overflow-hidden rounded-full bg-primary/12"
    >
      <motion.div
        className="relative h-full overflow-hidden rounded-full bg-gradient-to-r from-primary/70 to-primary"
        initial={{ width: "10%" }}
        animate={{ width: done ? "100%" : "92%" }}
        transition={
          done
            ? { duration: FINISH_MS / 1000, ease: [0.22, 1, 0.36, 1] }
            : { duration: HOLD_MS / 1000, ease: [0.35, 0.1, 0.75, 0.55] }
        }
      >
        {!reduced &&
          BUBBLES.map((b, i) => (
            <motion.span
              key={i}
              aria-hidden
              className="absolute top-1/2 rounded-full bg-primary-foreground/80 shadow-[0_0_6px_rgba(255,255,255,0.6)]"
              style={{ width: b.size, height: b.size, marginTop: -b.size / 2 }}
              initial={{ left: "-4%", opacity: 0, scale: 0.6 }}
              animate={{ left: ["-4%", "12%", "88%", "104%"], opacity: [0, 1, 1, 0], scale: [0.6, 1, 1, 0.8] }}
              transition={{
                duration: b.duration,
                delay: b.delay,
                repeat: Infinity,
                // Ease-in per ride too: each bubble speeds up as it goes.
                ease: [0.5, 0, 0.9, 0.5],
                times: [0, 0.15, 0.85, 1],
              }}
            />
          ))}
      </motion.div>
    </div>
  );
}
