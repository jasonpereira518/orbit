"use client";

import { motion } from "motion/react";
import { Mail } from "lucide-react";
import type { PreviewProps } from "@/components/onboarding/tour-config";
import { cn } from "@/lib/utils";

const recruiters = [
  { name: "Alex Rivera", firm: "Greylock · Talent", status: "Logged" },
  { name: "Jordan Kim", firm: "a16z · Recruiting", status: "New" },
  { name: "Sam Okonkwo", firm: "Sequoia · People", status: "Follow up" },
];

export function RecruitersPreview({ reducedMotion }: PreviewProps) {
  return (
    <div className="space-y-3 p-1">
      <div className="flex items-center justify-between gap-3">
        <p className="font-[family-name:var(--font-display)] text-lg text-primary">
          Recruiters
        </p>
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

      <ul className="space-y-2">
        {recruiters.map((r, i) => (
          <motion.li
            key={r.name}
            data-tour-hotspot={i === 0 ? "recruiter" : undefined}
            initial={reducedMotion ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reducedMotion ? 0 : 0.08 * i, duration: 0.35 }}
            className="flex items-center justify-between rounded-xl border border-border/60 bg-background/60 px-3 py-2.5"
          >
            <div>
              <p className="text-sm font-medium text-primary">{r.name}</p>
              <p className="text-xs text-muted-foreground">{r.firm}</p>
            </div>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-medium",
                r.status === "Logged"
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted-foreground"
              )}
            >
              {r.status}
            </span>
          </motion.li>
        ))}
      </ul>

      <motion.div
        data-tour-hotspot="gmail"
        initial={reducedMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: reducedMotion ? 0 : 0.35 }}
        className="flex items-center gap-2 rounded-xl border border-dashed border-border/70 bg-background/40 px-3 py-2.5"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-primary">
          <Mail className="h-3.5 w-3.5" />
        </span>
        <div>
          <p className="text-xs font-medium text-foreground">Import from Gmail</p>
          <p className="text-[10px] text-muted-foreground">
            Pull recruiter threads automatically
          </p>
        </div>
      </motion.div>
    </div>
  );
}
