"use client";

import { motion } from "motion/react";
import type { PreviewProps } from "@/components/onboarding/tour-config";

export function ChatPreview({ reducedMotion }: PreviewProps) {
  return (
    <div className="space-y-3 p-1">
      <p className="font-[family-name:var(--font-display)] text-lg text-primary">
        Chat
      </p>
      <motion.div
        data-tour-hotspot="question"
        initial={reducedMotion ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-xl border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
      >
        Who should I reach out to about AI internships?
      </motion.div>
      <motion.div
        data-tour-hotspot="answer"
        initial={reducedMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: reducedMotion ? 0 : 0.25 }}
        className="rounded-xl border border-border/60 bg-background/60 p-3"
      >
        <p className="text-sm leading-relaxed text-foreground">
          Start with <span className="font-medium text-primary">Marcus Lee</span>{" "}
          at Stripe — he offered an intro to their AI infra recruiting team last
          month.
        </p>
        <div className="mt-3 rounded-lg bg-accent/80 px-2.5 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wide text-primary">
            Suggested next
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Send a short note referencing the AWS chat.
          </p>
        </div>
      </motion.div>
    </div>
  );
}
