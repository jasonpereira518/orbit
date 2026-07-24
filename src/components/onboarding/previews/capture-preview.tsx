"use client";

import { motion } from "motion/react";
import type { PreviewProps } from "@/components/onboarding/tour-config";
import { cn } from "@/lib/utils";

export function CapturePreview({ reducedMotion }: PreviewProps) {
  return (
    <div className="space-y-3 p-1">
      <div className="flex items-center justify-between gap-3">
        <p className="font-[family-name:var(--font-display)] text-lg text-primary">
          Capture
        </p>
        <div
          data-tour-hotspot="mode"
          className="flex rounded-lg border border-border/70 bg-card p-0.5 text-[10px] font-medium"
        >
          <span className="rounded-md bg-primary px-2 py-1 text-primary-foreground shadow-sm">
            Messy
          </span>
          <span className="rounded-md px-2 py-1 text-muted-foreground">
            Structured
          </span>
        </div>
      </div>
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
          {["recruiting", "intro"].map((tag) => (
            <span
              key={tag}
              className={cn(
                "rounded-md bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
              )}
            >
              {tag}
            </span>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
