"use client";

import { motion } from "motion/react";
import { Check, Clock3 } from "lucide-react";
import type { PreviewProps } from "@/components/onboarding/tour-config";
import { cn } from "@/lib/utils";

const filters = ["Pending", "Done", "All"];

const reminders = [
  {
    title: "Follow up with Sarah Chen",
    due: "Overdue 2 days",
    overdue: true,
    type: "Post-meeting",
  },
  {
    title: "Send intro to Marcus Lee",
    due: "Due tomorrow",
    overdue: false,
    type: "AI suggested",
  },
  {
    title: "Check in with Priya Nair",
    due: "Due in 5 days",
    overdue: false,
    type: "Task",
  },
];

export function RemindersPreview({ reducedMotion }: PreviewProps) {
  return (
    <div className="space-y-3 p-1">
      <div className="flex items-center justify-between gap-3">
        <p className="font-[family-name:var(--font-display)] text-lg text-primary">
          Reminders
        </p>
        <div
          data-tour-hotspot="filter"
          className="flex rounded-lg border border-border/70 bg-muted/40 p-0.5 text-[10px] font-medium"
        >
          {filters.map((f, i) => (
            <span
              key={f}
              className={cn(
                "rounded-md px-2 py-1",
                i === 0
                  ? "bg-background text-primary shadow-sm"
                  : "text-muted-foreground"
              )}
            >
              {f}
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
            className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/60 px-3 py-2.5"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-primary">
                {r.title}
              </p>
              <div className="mt-0.5 flex items-center gap-1.5">
                <span
                  className={cn(
                    "text-[10px] font-medium",
                    r.overdue ? "text-destructive" : "text-muted-foreground"
                  )}
                >
                  {r.due}
                </span>
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
                  {r.type}
                </span>
              </div>
            </div>
            {i === 0 ? (
              <div
                data-tour-hotspot="action"
                className="flex shrink-0 items-center gap-1"
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-lg border border-border/70 text-muted-foreground">
                  <Clock3 className="h-3 w-3" />
                </span>
                <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Check className="h-3 w-3" />
                </span>
              </div>
            ) : null}
          </motion.li>
        ))}
      </ul>
    </div>
  );
}
