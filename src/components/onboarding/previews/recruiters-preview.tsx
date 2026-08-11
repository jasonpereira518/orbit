"use client";

import { motion } from "motion/react";
import { Lock, Mail, Star } from "lucide-react";
import type { PreviewProps } from "@/components/onboarding/tour-config";
import { PeopleViewTogglePreview } from "@/components/onboarding/previews/people-view-toggle-preview";
import { cn } from "@/lib/utils";

const recruiters = [
  {
    name: "Alex Rivera",
    firm: "Greylock · Talent",
    status: "active",
    rating: 4.6,
    logs: 3,
    locked: false,
  },
  {
    name: "Jordan Kim",
    firm: "a16z · Recruiting",
    status: "planned",
    rating: 4.2,
    logs: 0,
    locked: true,
  },
  {
    name: "Sam Okonkwo",
    firm: "Sequoia · People",
    status: "contacted",
    rating: 4.8,
    logs: 1,
    locked: false,
  },
];

export function RecruitersPreview({ reducedMotion }: PreviewProps) {
  return (
    <div className="space-y-3 p-1">
      <div className="flex items-center justify-between gap-3">
        <p className="font-[family-name:var(--font-display)] text-lg text-primary">
          Recruiters
        </p>
        <PeopleViewTogglePreview active="recruiters" />
      </div>

      <ul className="space-y-2">
        {recruiters.map((r, i) => (
          <motion.li
            key={r.name}
            data-tour-hotspot={i === 0 ? "recruiter" : undefined}
            initial={reducedMotion ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reducedMotion ? 0 : 0.08 * i, duration: 0.35 }}
            className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/60 px-3 py-2.5"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="truncate text-sm font-medium text-primary">
                  {r.name}
                </p>
                {r.locked && (
                  <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />
                )}
              </div>
              <p className="truncate text-xs text-muted-foreground">{r.firm}</p>
              <p className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                <Star className="h-2.5 w-2.5 fill-amber-400 text-amber-400" />
                {r.rating.toFixed(1)}
                <span className="mx-0.5">·</span>
                {r.logs} log{r.logs === 1 ? "" : "s"}
              </p>
            </div>
            <span
              className={cn(
                "shrink-0 rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-medium capitalize text-muted-foreground",
                r.status === "active" && "border-primary/30 bg-primary/10 text-primary"
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
        className="rounded-xl border border-border/70 bg-card px-3 py-2.5"
      >
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-primary">
            <Mail className="h-3.5 w-3.5" />
          </span>
          <div>
            <p className="text-xs font-medium text-foreground">Gmail import</p>
            <p className="text-[10px] text-muted-foreground">
              Pull recruiter threads automatically
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
