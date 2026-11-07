"use client";

import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";
import { appReducesMotion, prefersReducedMotion, subscribeReducedMotion } from "@/lib/motion-preference";

/**
 * Whether to animate: the system's `prefers-reduced-motion` or Orbit's own Reduce motion
 * setting (`lib/motion-preference.ts`). `false` on the server and in the first client render,
 * so hydration matches; it learns the preference in an effect and follows changes to either.
 */
export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const update = () => setReduced(prefersReducedMotion());
    update();
    return subscribeReducedMotion(update);
  }, []);

  return reduced;
}

/** The in-app setting alone, for the Settings toggle and MotionConfig. */
export function useAppReducesMotion() {
  const [on, setOn] = useState(false);

  useEffect(() => {
    const update = () => setOn(appReducesMotion());
    update();
    return subscribeReducedMotion(update);
  }, []);

  return on;
}

/**
 * motion/react's `useReducedMotion` (the system preference, read synchronously so a reduced
 * first render does not animate) or the in-app setting. For components that used Motion's hook.
 */
export function useReducedMotionPreference() {
  const system = useReducedMotion();
  const app = useAppReducesMotion();
  return Boolean(system) || app;
}
