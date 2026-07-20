"use client";

import { motion } from "motion/react";
import type { PreviewProps } from "@/components/onboarding/tour-config";

const cards = [
  { label: "Due soon", value: "3", hint: "Follow-ups this week", hotspot: "due" },
  { label: "Dormant", value: "5", hint: "No touch in 60+ days" },
  { label: "Suggestions", value: "2", hint: "AI outreach ideas" },
];

export function DashboardPreview({ reducedMotion }: PreviewProps) {
  return (
    <div className="space-y-3 p-1">
      <p className="font-[family-name:var(--font-display)] text-lg text-primary">
        Dashboard
      </p>
      <div className="grid grid-cols-3 gap-2">
        {cards.map((c, i) => (
          <motion.div
            key={c.label}
            data-tour-hotspot={c.hotspot}
            initial={reducedMotion ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reducedMotion ? 0 : 0.1 * i }}
            className="rounded-xl border border-border/60 bg-background/60 p-2.5"
          >
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {c.label}
            </p>
            <p className="mt-1 font-[family-name:var(--font-display)] text-2xl text-primary">
              {c.value}
            </p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">{c.hint}</p>
          </motion.div>
        ))}
      </div>
      <motion.div
        data-tour-hotspot="suggestion"
        initial={reducedMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: reducedMotion ? 0 : 0.4 }}
        className="rounded-xl border border-border/60 bg-background/60 px-3 py-2.5"
      >
        <p className="text-xs font-medium text-foreground">
          Reach out to Priya Nair
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Last touch 47 days ago · Suggested: coffee catch-up
        </p>
      </motion.div>
    </div>
  );
}
