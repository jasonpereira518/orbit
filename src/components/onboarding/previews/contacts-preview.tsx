"use client";

import { motion } from "motion/react";
import type { PreviewProps } from "@/components/onboarding/tour-config";
import { PeopleViewTogglePreview } from "@/components/onboarding/previews/people-view-toggle-preview";
import { ClosenessTierBadge } from "@/components/dashboard/closeness-tier-badge";
import { closenessPercentChipClass } from "@/lib/closeness";
import { cn } from "@/lib/utils";

const people = [
  {
    name: "Sarah Chen",
    meta: "OpenAI · Partnerships",
    closeness: 0.82,
    tier: "inner" as const,
  },
  {
    name: "Marcus Lee",
    meta: "Stripe · Recruiting",
    closeness: 0.54,
    tier: "mid" as const,
  },
  {
    name: "Priya Nair",
    meta: "Notion · Agents",
    closeness: 0.28,
    tier: "outer" as const,
  },
];

export function ContactsPreview({ reducedMotion }: PreviewProps) {
  return (
    <div className="space-y-3 p-1">
      <div className="flex items-center justify-between gap-3">
        <p className="font-[family-name:var(--font-display)] text-lg text-primary">
          Contacts
        </p>
        <PeopleViewTogglePreview active="contacts" />
      </div>
      <div
        data-tour-hotspot="search"
        className="h-8 rounded-lg border border-border/70 bg-muted/40 px-3 text-[11px] leading-8 text-muted-foreground/70"
      >
        Search people…
      </div>
      <ul className="space-y-2">
        {people.map((p, i) => (
          <motion.li
            key={p.name}
            data-tour-hotspot={i === 0 ? "contact" : undefined}
            initial={reducedMotion ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reducedMotion ? 0 : 0.08 * i, duration: 0.35 }}
            className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/60 px-3 py-2.5"
          >
            <div className="min-w-0 flex items-center gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-medium text-primary">
                {p.name
                  .split(" ")
                  .map((n) => n[0])
                  .join("")}
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="truncate text-sm font-medium text-primary">
                    {p.name}
                  </p>
                  {i === 0 && (
                    <ClosenessTierBadge tier={p.tier} className="hidden sm:inline-flex" />
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">{p.meta}</p>
              </div>
            </div>
            <span
              data-tour-hotspot={i === 0 ? "score" : undefined}
              className={cn(
                "shrink-0 rounded-md px-1.5 py-0.5 text-sm font-medium tabular-nums",
                closenessPercentChipClass(p.closeness)
              )}
            >
              {Math.round(p.closeness * 100)}%
            </span>
          </motion.li>
        ))}
      </ul>
    </div>
  );
}
