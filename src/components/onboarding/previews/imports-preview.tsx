"use client";

import { motion } from "motion/react";
import { FileSpreadsheet, Calendar, MessageSquare } from "lucide-react";
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
    <div className="space-y-3 p-1">
      <p className="font-[family-name:var(--font-display)] text-lg text-primary">
        Imports
      </p>
      <ul className="space-y-2">
        {sources.map((s, i) => {
          const Icon = s.icon;
          return (
            <motion.li
              key={s.label}
              data-tour-hotspot={s.hotspot}
              initial={reducedMotion ? false : { opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: reducedMotion ? 0 : 0.1 * i }}
              className="flex items-center gap-3 rounded-xl border border-border/60 bg-background/60 px-3 py-2.5"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-primary">
                <Icon className="h-4 w-4" />
              </span>
              <div>
                <p className="text-sm font-medium">{s.label}</p>
                <p className="text-xs text-muted-foreground">{s.detail}</p>
              </div>
            </motion.li>
          );
        })}
      </ul>
    </div>
  );
}
