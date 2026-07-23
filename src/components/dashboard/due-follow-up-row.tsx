"use client";

import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { EasyFollowUp } from "@/components/follow-up/easy-follow-up";
import { ClosenessTierBadge } from "@/components/dashboard/closeness-tier-badge";
import { cn } from "@/lib/utils";

function followUpDueLabel(nextFollowUpAt?: Date | string | null) {
  if (!nextFollowUpAt) return null;
  const d = new Date(nextFollowUpAt);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const overdue = d <= now;
  if (overdue) {
    const days = Math.max(
      1,
      Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24))
    );
    return { text: `Overdue ${days} day${days === 1 ? "" : "s"}`, overdue: true };
  }
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return { text: "Due today", overdue: false };
  return {
    text: `Due ${formatDistanceToNow(d, { addSuffix: true })}`,
    overdue: false,
  };
}

function lastTouchLabel(lastInteractionAt?: Date | string | null) {
  if (!lastInteractionAt) return "No logged touch";
  const d = new Date(lastInteractionAt);
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (days <= 0) return "Last touch today";
  return `Last touch ${days}d ago`;
}

export function DueFollowUpRow({
  id,
  fullName,
  title,
  company,
  tier,
  nextFollowUpAt,
  lastInteractionAt,
}: {
  id: string;
  fullName: string;
  title: string | null;
  company: string | null;
  tier?: "inner" | "mid" | "outer";
  nextFollowUpAt?: Date | string | null;
  lastInteractionAt?: Date | string | null;
}) {
  const due = followUpDueLabel(nextFollowUpAt);
  const lastTouch = lastTouchLabel(lastInteractionAt);
  const meta = [
    [title, company].filter(Boolean).join(" · "),
    due?.text,
    lastTouch,
  ].filter(Boolean);

  return (
    <div className="rounded-xl border border-border/60 bg-card p-3">
      <div className="flex items-start justify-between gap-3">
        <Link href={`/contacts/${id}`} className="min-w-0 hover:underline">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-primary">{fullName}</p>
            {tier && <ClosenessTierBadge tier={tier} />}
          </div>
          {meta.length > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {meta.map((part, i) => (
                <span key={i}>
                  {i > 0 && (
                    <span
                      className={cn(
                        "mx-1.5",
                        due?.overdue && i === 1 && "text-amber-700 dark:text-amber-300 font-medium"
                      )}
                    >
                      ·
                    </span>
                  )}
                  <span
                    className={cn(
                      due?.overdue && i === 1 && "font-medium text-amber-700 dark:text-amber-300"
                    )}
                  >
                    {part}
                  </span>
                </span>
              ))}
            </p>
          )}
        </Link>
      </div>
      <EasyFollowUp
        contactId={id}
        contactName={fullName}
        nextFollowUpAt={nextFollowUpAt}
        compact
        className="mt-2"
      />
    </div>
  );
}
