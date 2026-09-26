"use client";

import { motion } from "motion/react";
import { Check, Clock } from "lucide-react";
import type { PreviewProps } from "@/components/onboarding/tour-config";
import { reminderTypeLabel, reminderTypeStyle } from "@/lib/reminder-display";
import { cn } from "@/lib/utils";

// Provenance chips come from the same table the real page uses, so the tour can't drift.
const reminders = [
  {
    title: "Follow up with Priya Nair",
    type: "ai_suggested",
    due: "Overdue 2 days",
    overdue: true,
  },
  {
    title: "Call recruiter re: offer",
    type: "manual",
    due: "Today",
    overdue: false,
  },
  {
    title: "Send notes from coffee chat",
    type: "post_meeting",
    due: "Today",
    overdue: false,
  },
];

/** The page's smart views, in rail order. */
const VIEWS = ["Today", "Upcoming", "Done"];

export function RemindersPreview({ reducedMotion }: PreviewProps) {
  return (
    <div className="space-y-3 p-1">
      <div className="flex items-center justify-between gap-3">
        <p className="font-[family-name:var(--font-display)] text-lg text-ink">
          Reminders
        </p>
        <div
          data-tour-hotspot="status"
          className="flex rounded-lg border border-border/70 bg-muted/40 p-0.5 text-[10px] font-medium"
        >
          {VIEWS.map((label) => (
            <span
              key={label}
              className={cn(
                "rounded-md px-2 py-1",
                label === "Today"
                  ? "bg-background text-primary shadow-sm"
                  : "text-muted-foreground"
              )}
            >
              {label}
            </span>
          ))}
        </div>
      </div>

      <ul className="space-y-2">
        {reminders.map((r, i) => (
          <motion.li
            key={r.title}
            data-tour-hotspot={i === 0 ? "reminder" : undefined}
            initial={reducedMotion ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reducedMotion ? 0 : 0.08 * i, duration: 0.35 }}
            className="rounded-xl border border-border/60 bg-background/60 px-3 py-2.5"
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <p className="text-sm font-medium text-ink">{r.title}</p>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[9px] font-medium uppercase tracking-wide",
                  reminderTypeStyle(r.type)
                )}
              >
                {reminderTypeLabel(r.type)}
              </span>
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <p
                className={cn(
                  "text-xs",
                  r.overdue
                    ? "font-medium text-amber-700 dark:text-warning"
                    : "text-muted-foreground"
                )}
              >
                {r.due}
              </p>
              {i === 0 && (
                <div
                  data-tour-hotspot="actions"
                  className="flex items-center gap-1 text-muted-foreground"
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-muted">
                    <Check className="h-3.5 w-3.5" />
                  </span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-muted">
                    <Clock className="h-3.5 w-3.5" />
                  </span>
                </div>
              )}
            </div>
          </motion.li>
        ))}
      </ul>
    </div>
  );
}
