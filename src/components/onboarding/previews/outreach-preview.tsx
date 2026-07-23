"use client";

import { motion } from "motion/react";
import { Plus } from "lucide-react";
import type { PreviewProps } from "@/components/onboarding/tour-config";

export function OutreachPreview({ reducedMotion }: PreviewProps) {
  return (
    <div className="space-y-3 p-1">
      <div className="flex items-center justify-between gap-3">
        <p className="font-[family-name:var(--font-display)] text-lg text-primary">
          Outreach
        </p>
        <div
          data-tour-hotspot="new"
          className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-[10px] font-medium text-primary-foreground"
        >
          <Plus className="h-3 w-3" />
          New campaign
        </div>
      </div>

      <motion.div
        data-tour-hotspot="campaign"
        initial={reducedMotion ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reducedMotion ? 0 : 0.35 }}
        className="rounded-xl border border-border/60 bg-background/60 px-3 py-3"
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-medium text-primary">
              Series A founders · SF
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              12 prospects · 4 drafted · 2 sent
            </p>
          </div>
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
            Active
          </span>
        </div>
      </motion.div>

      <motion.div
        data-tour-hotspot="draft"
        initial={reducedMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: reducedMotion ? 0 : 0.25 }}
        className="rounded-xl border border-border/60 bg-background/60 px-3 py-2.5"
      >
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Sample draft
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-foreground">
          Hi Maya — loved your write-up on agent evals. Would you be open to a
          quick chat about how you&apos;re hiring for research eng?
        </p>
      </motion.div>
    </div>
  );
}
