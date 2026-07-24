"use client";

import { motion } from "motion/react";
import { Bell, Sparkles, Users } from "lucide-react";
import type { PreviewProps } from "@/components/onboarding/tour-config";
import { ClosenessTierBadge } from "@/components/dashboard/closeness-tier-badge";

const cards = [
  {
    label: "Contacts",
    value: "12",
    hint: "People in your network",
    icon: Users,
  },
  {
    label: "Due follow-ups",
    value: "3",
    hint: "Needs attention",
    hotspot: "due",
    icon: Bell,
  },
  {
    label: "Strong ties",
    value: "5",
    hint: "Inner + mid orbit",
    icon: Sparkles,
  },
  {
    label: "Reminders",
    value: "2",
    hint: "Pending tasks",
    hotspot: "reminder",
    icon: Bell,
  },
];

export function DashboardPreview({ reducedMotion }: PreviewProps) {
  return (
    <div className="space-y-3 p-1">
      <div>
        <p className="text-[10px] font-medium uppercase tracking-wide text-primary/80">
          Your network
        </p>
        <p className="font-[family-name:var(--font-display)] text-lg text-primary">
          Stay in orbit
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {cards.map((c, i) => {
          const Icon = c.icon;
          return (
            <motion.div
              key={c.label}
              data-tour-hotspot={c.hotspot}
              initial={reducedMotion ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: reducedMotion ? 0 : 0.08 * i }}
              className="rounded-xl border border-border/60 bg-background/60 p-2.5"
            >
              <div className="flex items-center justify-between gap-1">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {c.label}
                </p>
                <Icon className="h-3 w-3 text-muted-foreground/70" />
              </div>
              <p className="mt-1 font-[family-name:var(--font-display)] text-2xl text-primary">
                {c.value}
              </p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">{c.hint}</p>
            </motion.div>
          );
        })}
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <motion.div
          data-tour-hotspot="suggestion"
          initial={reducedMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: reducedMotion ? 0 : 0.35 }}
          className="rounded-xl border border-border/60 bg-background/60 px-3 py-2.5"
        >
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Suggested outreach
          </p>
          <div className="mt-1.5 flex items-start gap-2">
            <ClosenessTierBadge tier="outer" dotOnly className="mt-1.5" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-foreground">
                Reach out to Priya Nair
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Last touch 47 days ago · coffee catch-up
              </p>
            </div>
          </div>
        </motion.div>

        <motion.div
          initial={reducedMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: reducedMotion ? 0 : 0.45 }}
          className="rounded-xl border border-border/60 bg-background/60 px-3 py-2.5"
        >
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Reminders
          </p>
          <p className="mt-1.5 text-xs font-medium text-foreground">
            Follow up with Marcus Lee
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Due tomorrow · Stripe AI intro
          </p>
        </motion.div>
      </div>
    </div>
  );
}
