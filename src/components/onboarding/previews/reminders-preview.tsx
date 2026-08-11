"use client";

import { motion } from "motion/react";
import { Check, Clock } from "lucide-react";
import type { PreviewProps } from "@/components/onboarding/tour-config";
import { cn } from "@/lib/utils";

const lists = [
  { name: "Follow-ups", count: 4, active: true },
  { name: "Intros", count: 2, active: false },
];

const items = [
  {
    title: "Follow up with Marcus Lee",
    meta: "Due tomorrow · Stripe AI intro",
    hotspot: "item" as const,
  },
  {
    title: "Send thank-you to Sarah Chen",
    meta: "Due in 3 days · AWS Summit",
  },
];

export function RemindersPreview({ reducedMotion }: PreviewProps) {
  return (
    <div className="space-y-3 p-1">
      <p className="font-[family-name:var(--font-display)] text-lg text-primary">
        Reminders
      </p>

      <div data-tour-hotspot="list" className="flex flex-wrap gap-1.5">
        {lists.map((list) => (
          <span
            key={list.name}
            className={cn(
              "rounded-lg border px-2.5 py-1 text-[11px] font-medium",
              list.active
                ? "border-primary/30 bg-primary text-primary-foreground"
                : "border-border/70 bg-background/60 text-muted-foreground"
            )}
          >
            {list.name}
            <span className="ml-1.5 opacity-70">{list.count}</span>
          </span>
        ))}
      </div>

      <ul className="space-y-2">
        {items.map((item, i) => (
          <motion.li
            key={item.title}
            data-tour-hotspot={item.hotspot}
            initial={reducedMotion ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reducedMotion ? 0 : 0.1 * i }}
            className="rounded-xl border border-border/60 bg-background/60 px-3 py-2.5"
          >
            <p className="text-sm font-medium text-foreground">{item.title}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {item.meta}
            </p>
          </motion.li>
        ))}
      </ul>

      <motion.div
        data-tour-hotspot="action"
        initial={reducedMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: reducedMotion ? 0 : 0.35 }}
        className="flex items-center gap-2"
      >
        <span className="inline-flex items-center gap-1 rounded-lg border border-border/70 bg-card px-2.5 py-1.5 text-[11px] font-medium text-foreground">
          <Check className="h-3 w-3 text-primary" />
          Done
        </span>
        <span className="inline-flex items-center gap-1 rounded-lg border border-border/70 bg-card px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">
          <Clock className="h-3 w-3" />
          Snooze
        </span>
        <span className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-[11px] font-medium text-primary-foreground">
          Follow up
        </span>
      </motion.div>
    </div>
  );
}
