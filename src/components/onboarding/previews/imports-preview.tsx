"use client";

import { motion } from "motion/react";
import { FileSpreadsheet, Calendar, MessageSquare, ArrowRight } from "lucide-react";
import type { PreviewProps } from "@/components/onboarding/tour-config";

const sources = [
  {
    icon: FileSpreadsheet,
    label: "LinkedIn connections",
    detail: "CSV import",
    hotspot: "linkedin",
  },
  {
    icon: MessageSquare,
    label: "LinkedIn messages",
    detail: "Enrich threads",
    hotspot: "messages",
  },
  {
    icon: Calendar,
    label: "Calendar ICS",
    detail: "Meeting sync",
    hotspot: "calendar",
  },
];

export function ImportsPreview({ reducedMotion }: PreviewProps) {
  return (
    <div className="space-y-1.5 p-1">
      <p className="font-[family-name:var(--font-display)] text-lg text-primary">
        Imports
      </p>
      <ul className="space-y-1">
        {sources.map((s, i) => {
          const Icon = s.icon;
          return (
            <motion.li
              key={s.label}
              data-tour-hotspot={s.hotspot}
              initial={reducedMotion ? false : { opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: reducedMotion ? 0 : 0.1 * i }}
              className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-background/60 px-3 py-1.5"
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-accent text-primary">
                <Icon className="h-3 w-3" />
              </span>
              <div>
                <p className="text-sm font-medium">{s.label}</p>
                <p className="text-[11px] text-muted-foreground">{s.detail}</p>
              </div>
            </motion.li>
          );
        })}
      </ul>
      <motion.p
        data-tour-hotspot="knowledge"
        initial={reducedMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: reducedMotion ? 0 : 0.35 }}
        className="flex items-center gap-1 px-1 text-[11px] text-muted-foreground"
      >
        <ArrowRight className="h-3 w-3 shrink-0" />
        Browse everything you&apos;ve imported in{" "}
        <span className="font-medium text-primary">Knowledge</span>
      </motion.p>
    </div>
  );
}
