"use client";

import { MotionPreferenceConfig } from "@/components/motion/motion-preference-config";

// The marketing tree never passes through AppShell, so it needs its own
// MotionConfig for motion/react to honor reduced motion (system or in-app setting).
export function LandingMotionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return <MotionPreferenceConfig>{children}</MotionPreferenceConfig>;
}
