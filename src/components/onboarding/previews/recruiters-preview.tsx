"use client";

import { motion } from "motion/react";
import { Globe2, Mail, PenLine } from "lucide-react";
import type { PreviewProps } from "@/components/onboarding/tour-config";
import { cn } from "@/lib/utils";

const recruiters = [
  { name: "Alex Rivera", firm: "Greylock · Talent", status: "contacted" },
  { name: "Jordan Kim", firm: "a16z · Recruiting", status: "planned" },
  { name: "Sam Okonkwo", firm: "Sequoia · People", status: "active" },
];

export function RecruitersPreview({ reducedMotion }: PreviewProps) {
  return (
    <div className="space-y-2.5 p-1">
      <div className="flex items-center justify-between gap-3">
        <p className="font-[family-name:var(--font-display)] text-lg text-ink">
          Recruiters
        </p>
        <div className="flex items-center gap-1.5">
          <div
            data-tour-hotspot="compose"
            className="flex items-center gap-1 rounded-lg border border-border/70 bg-background/60 px-2 py-1 text-[10px] font-medium text-foreground"
          >
            <PenLine className="h-3 w-3" />
            Compose
          </div>
          <div
            data-tour-hotspot="toggle"
            className="flex rounded-lg border border-border/70 bg-muted/40 p-0.5 text-[10px] font-medium"
          >
            <span className="rounded-md px-2 py-1 text-muted-foreground">
              Contacts
            </span>
            <span className="rounded-md bg-background px-2 py-1 text-primary shadow-sm">
              Recruiters
            </span>
          </div>
        </div>
      </div>

      <motion.div
        data-tour-hotspot="sharing"
        initial={reducedMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reducedMotion ? 0 : 0.3 }}
        className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/60 px-3 py-2"
      >
        <div className="flex items-center gap-2">
          <Globe2 className="h-3.5 w-3.5 text-primary" />
          <p className="text-xs font-medium text-foreground">
            Sharing with the pool
          </p>
        </div>
        <span className="rounded-md border border-border/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          Make private
        </span>
      </motion.div>

      <motion.div
        data-tour-hotspot="scan"
        initial={reducedMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: reducedMotion ? 0 : 0.1, duration: 0.3 }}
        className="space-y-1.5 rounded-xl border border-border/60 bg-background/60 px-3 py-2"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs text-foreground">
            <Mail className="h-3.5 w-3.5 text-muted-foreground" />
            Searching your mailbox…
          </span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-border/60">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary/60" />
        </div>
      </motion.div>

      <ul className="space-y-1.5">
        {recruiters.map((r, i) => (
          <motion.li
            key={r.name}
            initial={reducedMotion ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reducedMotion ? 0 : 0.08 * i, duration: 0.35 }}
            className="flex items-center justify-between rounded-xl border border-border/60 bg-background/60 px-3 py-2"
          >
            <div>
              <p className="text-sm font-medium text-ink">{r.name}</p>
              <p className="text-xs text-muted-foreground">{r.firm}</p>
            </div>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-medium",
                "bg-muted text-muted-foreground"
              )}
            >
              {r.status}
            </span>
          </motion.li>
        ))}
      </ul>
    </div>
  );
}
