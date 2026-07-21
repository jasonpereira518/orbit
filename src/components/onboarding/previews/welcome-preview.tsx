"use client";

import { motion } from "motion/react";
import type { PreviewProps } from "@/components/onboarding/tour-config";
import { OrbitLogo } from "@/components/orbit-logo";

export function WelcomePreview({ reducedMotion }: PreviewProps) {
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center gap-4 p-6 text-center">
      <motion.div
        data-tour-hotspot="logo"
        initial={reducedMotion ? false : { scale: 0.7, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={
          reducedMotion
            ? { duration: 0 }
            : { type: "spring", stiffness: 260, damping: 20 }
        }
        className="shadow-[0_0_40px_rgba(89,157,231,0.35)]"
      >
        <OrbitLogo size="xl" />
      </motion.div>
      <motion.div
        data-tour-hotspot="tagline"
        initial={reducedMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: reducedMotion ? 0 : 0.2 }}
      >
        <p className="font-[family-name:var(--font-display)] text-2xl text-primary">
          Orbit
        </p>
        <p className="mt-1 max-w-xs text-sm text-muted-foreground">
          Your personal networking tracker — capture, organize, and act.
        </p>
      </motion.div>
    </div>
  );
}
