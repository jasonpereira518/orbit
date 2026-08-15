"use client";

import { MotionConfig } from "motion/react";

// The marketing tree never passes through AppShell, so it needs its own
// MotionConfig for motion/react to honor prefers-reduced-motion.
export function LandingMotionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
