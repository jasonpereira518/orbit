"use client";

import { motion } from "motion/react";
import type { PreviewProps } from "@/components/onboarding/tour-config";

const people = [
  {
    name: "Sarah Chen",
    meta: "OpenAI · Partnerships",
    closeness: 78,
    chipClass: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  {
    name: "Marcus Lee",
    meta: "Stripe · Recruiting",
    closeness: 41,
    chipClass: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  {
    name: "Priya Nair",
    meta: "Notion · Agents",
    closeness: 92,
    chipClass: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
];

export function ContactsPreview({ reducedMotion }: PreviewProps) {
  return (
    <div className="space-y-3 p-1">
      <div className="flex items-center justify-between gap-3">
        <p className="font-[family-name:var(--font-display)] text-lg text-primary">
          Contacts
        </p>
        <div
          data-tour-hotspot="search"
          className="h-7 flex-1 max-w-[10rem] rounded-lg border border-border/70 bg-muted/50"
        />
      </div>
      <ul className="space-y-2">
        {people.map((p, i) => (
          <motion.li
            key={p.name}
            data-tour-hotspot={i === 0 ? "contact" : undefined}
            initial={reducedMotion ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reducedMotion ? 0 : 0.08 * i, duration: 0.35 }}
            className="flex items-center justify-between rounded-xl border border-border/60 bg-background/60 px-3 py-2.5"
          >
            <div>
              <p className="text-sm font-medium text-primary">{p.name}</p>
              <p className="text-xs text-muted-foreground">{p.meta}</p>
            </div>
            <span
              data-tour-hotspot={i === 0 ? "score" : undefined}
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums ${p.chipClass}`}
            >
              {p.closeness}%
            </span>
          </motion.li>
        ))}
      </ul>
    </div>
  );
}
