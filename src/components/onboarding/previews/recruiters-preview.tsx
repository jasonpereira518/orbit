"use client";

import { motion } from "motion/react";
import { Globe2, Mail, PenLine } from "lucide-react";
import type { PreviewProps } from "@/components/onboarding/tour-config";
import { cn } from "@/lib/utils";

const recruiters = [
  { name: "Alex Rivera", firm: "Greylock · Talent", status: "contacted" },
  { name: "Jordan Kim", firm: "a16z · Recruiting", status: "planned" },
];

export function RecruitersPreview({ reducedMotion }: PreviewProps) {
  return (
    <div className="space-y-2 p-1">
      <div className="flex items-center justify-between gap-3">
        <p className="font-[family-name:var(--font-display)] text-lg text-primary">
          Recruiters
        </p>
        <span
          data-tour-hotspot="compose"
          className="flex items-center gap-1 rounded-lg border border-border/70 px-2 py-1 text-[10px] font-medium text-foreground"
        >
          <PenLine className="h-3 w-3" />
          Compose
        </span>
      </div>

      <motion.div
        data-tour-hotspot="sharing"
        initial={reducedMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-background/60 px-3 py-2"
      >
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Globe2 className="h-3.5 w-3.5" />
          </span>
          <p className="text-xs font-medium text-foreground">
            Share your list to see everyone else&apos;s
          </p>
        </div>
        <span className="rounded-md bg-primary px-2 py-1 text-[10px] font-medium text-primary-foreground">
          Share
        </span>
      </motion.div>

      <motion.div
        data-tour-hotspot="gmail"
        initial={reducedMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: reducedMotion ? 0 : 0.15 }}
        className="flex items-center gap-2 rounded-xl border border-dashed border-border/70 bg-background/40 px-3 py-2"
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-accent text-primary">
          <Mail className="h-3 w-3" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-medium text-foreground">
            Searching your whole mailbox…
          </p>
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
            <motion.div
              className="h-full rounded-full bg-primary"
              initial={reducedMotion ? { width: "45%" } : { width: "0%" }}
              animate={{ width: "45%" }}
              transition={{ duration: reducedMotion ? 0 : 1, delay: 0.2 }}
            />
          </div>
        </div>
      </motion.div>

      <ul className="space-y-1.5">
        {recruiters.map((r, i) => (
          <motion.li
            key={r.name}
            data-tour-hotspot={i === 0 ? "recruiter" : undefined}
            initial={reducedMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reducedMotion ? 0 : 0.3 + 0.08 * i, duration: 0.3 }}
            className="flex items-center justify-between rounded-xl border border-border/60 bg-background/60 px-3 py-1.5"
          >
            <div>
              <p className="text-sm font-medium text-primary">{r.name}</p>
              <p className="text-[11px] text-muted-foreground">{r.firm}</p>
            </div>
            <span
              className={cn(
                "rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-secondary-foreground"
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
