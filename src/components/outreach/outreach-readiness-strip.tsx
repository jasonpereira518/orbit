"use client";

import { useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { ReadinessItem, ReadinessStatus } from "@/lib/outreach-readiness";
import { overallReadiness, readinessHeadline } from "@/lib/outreach-readiness";
import { cn } from "@/lib/utils";

const TONE: Record<
  ReadinessStatus,
  { icon: LucideIcon; dot: string; text: string; strip: string }
> = {
  ready: {
    icon: CheckCircle2,
    dot: "text-primary",
    text: "text-muted-foreground",
    strip: "border-border/70 bg-card",
  },
  attention: {
    icon: AlertTriangle,
    dot: "text-amber-500",
    text: "text-ink",
    strip: "border-amber-500/30 bg-amber-500/5",
  },
  blocked: {
    icon: XCircle,
    dot: "text-destructive",
    text: "text-ink",
    strip: "border-destructive/30 bg-destructive/5",
  },
};

/**
 * What will and will not work, shown before the campaign is built rather than at the moment
 * of sending.
 *
 * Collapsed by default when everything is ready, so an account that is fully configured
 * sees one quiet line instead of a checklist it has already satisfied. Expanded by default
 * the moment anything is blocked or needs attention — that is the whole point, and hiding
 * it behind a click would reproduce the problem this replaces, where the truth existed but
 * only appeared after the work.
 *
 * Each row says what is true and what it means for a send; the fix link goes straight to
 * the settings section that changes it. Items with no fix link are deployment-level facts
 * the account holder cannot act on, and they say so in their own text rather than offering
 * a button that leads nowhere.
 */
export function OutreachReadinessStrip({
  items,
  className,
}: {
  items: ReadinessItem[];
  className?: string;
}) {
  const overall = overallReadiness(items);
  // Not a lazy `useState` initializer over some stored preference: this is derived purely
  // from the data, so it re-derives correctly whenever the page re-renders with new facts.
  const [open, setOpen] = useState(overall !== "ready");

  if (items.length === 0) return null;

  const tone = TONE[overall];
  const Icon = tone.icon;

  return (
    <section className={cn("rounded-2xl border px-5 py-4", tone.strip, className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 text-left"
      >
        <Icon className={cn("size-4 shrink-0", tone.dot)} aria-hidden />
        <span className={cn("min-w-0 flex-1 text-sm font-medium", tone.text)}>
          {readinessHeadline(items)}
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-base",
            open && "rotate-180"
          )}
          aria-hidden
        />
      </button>

      {open && (
        <ul className="mt-3 space-y-2 border-t border-border/50 pt-3">
          {items.map((item) => {
            const rowTone = TONE[item.status];
            const RowIcon = rowTone.icon;
            return (
              <li key={item.id} className="flex items-start gap-3 text-sm">
                <RowIcon
                  className={cn("mt-0.5 size-3.5 shrink-0", rowTone.dot)}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-ink">{item.label}</span>
                  <span className="text-muted-foreground"> — {item.detail}</span>
                </div>
                {item.fix && (
                  <Link
                    href={item.fix.href}
                    className="shrink-0 text-xs underline-offset-4 hover:underline"
                  >
                    {item.fix.label}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
