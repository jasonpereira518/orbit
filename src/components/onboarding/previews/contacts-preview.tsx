"use client";

import { motion } from "motion/react";
import type { PreviewProps } from "@/components/onboarding/tour-config";

const people = [
  { name: "Sarah Chen", meta: "OpenAI · Partnerships", score: 4 },
  { name: "Marcus Lee", meta: "Stripe · Recruiting", score: 3 },
  { name: "Priya Nair", meta: "Notion · Agents", score: 5 },
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
              className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
            >
              {p.score}/5
            </span>
          </motion.li>
        ))}
      </ul>
    </div>
  );
}
