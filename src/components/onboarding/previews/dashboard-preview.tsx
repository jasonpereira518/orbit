"use client";

import { motion } from "motion/react";
import type { PreviewProps } from "@/components/onboarding/tour-config";

const cards = [
  { label: "Contacts", value: "12", hint: "People in your network", hotspot: "due" },
  { label: "Due follow-ups", value: "3", hint: "Needs attention" },
  { label: "Strong ties", value: "5", hint: "Inner + mid orbit" },
  { label: "Reminders", value: "2", hint: "Pending tasks" },
];

export function DashboardPreview({ reducedMotion }: PreviewProps) {
  return (
    <div className="space-y-3 p-1">
      <p className="font-[family-name:var(--font-display)] text-lg text-primary">
        Dashboard
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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
