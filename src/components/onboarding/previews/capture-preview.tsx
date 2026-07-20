"use client";

import { motion } from "motion/react";
import type { PreviewProps } from "@/components/onboarding/tour-config";

export function CapturePreview({ reducedMotion }: PreviewProps) {
  return (
    <div className="space-y-3 p-1">
      <p className="font-[family-name:var(--font-display)] text-lg text-primary">
        Capture
      </p>
      <motion.div
        data-tour-hotspot="notes"
        initial={reducedMotion ? false : { opacity: 0.4 }}
        animate={{ opacity: 1 }}
        className="rounded-xl border border-border/60 bg-background/60 p-3"
      >
        <p className="text-xs leading-relaxed text-muted-foreground">
          Met Sarah Chen at AWS Summit. She leads Codex partnerships at OpenAI —
          offered an intro to their university recruiting lead…
        </p>
      </motion.div>
      <motion.div
        data-tour-hotspot="extraction"
        initial={reducedMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: reducedMotion ? 0 : 0.35 }}
        className="rounded-xl border border-primary/25 bg-primary/5 p-3"
      >
        <p className="text-[10px] font-medium uppercase tracking-wide text-primary">
          AI extraction
        </p>
        <p className="mt-1 text-sm font-medium text-foreground">Sarah Chen</p>
        <p className="text-xs text-muted-foreground">
          OpenAI · Partnerships · Follow up in 14 days
        </p>
        <div className="mt-2 flex gap-1.5">
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px]">
            recruiting
          </span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px]">
            intro
          </span>
        </div>
      </motion.div>
    </div>
  );
}
