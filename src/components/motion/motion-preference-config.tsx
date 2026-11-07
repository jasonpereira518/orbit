"use client";

import { MotionConfig } from "motion/react";
import { useAppReducesMotion } from "@/lib/use-prefers-reduced-motion";

/**
 * MotionConfig for every motion/react animation: follows the system preference ("user"), and
 * turns motion down regardless ("always") when Orbit's own Reduce motion setting is on.
 */
export function MotionPreferenceConfig({ children }: { children: React.ReactNode }) {
  const appReduces = useAppReducesMotion();
  return <MotionConfig reducedMotion={appReduces ? "always" : "user"}>{children}</MotionConfig>;
}
