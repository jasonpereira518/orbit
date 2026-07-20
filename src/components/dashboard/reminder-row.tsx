"use client";

import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { ReminderActions } from "@/components/dashboard/reminder-actions";
import { cn } from "@/lib/utils";

const TYPE_LABELS: Record<string, string> = {
  manual: "Task",
  capture: "From capture",
  post_meeting: "Post-meeting",
  generated: "Auto-generated",
};

const TYPE_STYLES: Record<string, string> = {
  manual: "bg-muted text-muted-foreground",
  capture: "bg-violet-500/15 text-violet-800 dark:text-violet-200",
  post_meeting: "bg-sky-500/15 text-sky-800 dark:text-sky-200",
  generated: "bg-muted text-muted-foreground",
};

function dueLabel(dueDate: Date | string | null | undefined) {
  if (!dueDate) return null;
  const d = new Date(dueDate);
  if (Number.isNaN(d.getTime())) return null;
  const overdue = d <= new Date();
  if (overdue) {
    const days = Math.max(
      1,
      Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24))
    );
    return { text: `Overdue ${days} day${days === 1 ? "" : "s"}`, overdue: true };
  }
  return {
    text: `Due ${formatDistanceToNow(d, { addSuffix: true })}`,
    overdue: false,
  };
}

export function ReminderRow({
  id,
  title,
  description,
  dueDate,
  reminderType,
  contactId,
  contactName,
}: {
  id: string;
  title: string;
  description?: string | null;
  dueDate?: Date | string | null;
  reminderType: string;
  contactId?: string | null;
  contactName?: string | null;
}) {
  const due = dueLabel(dueDate);
  const typeLabel = TYPE_LABELS[reminderType] ?? "Task";

  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-border/60 bg-card p-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">{title}</p>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
              TYPE_STYLES[reminderType] ?? TYPE_STYLES.manual
            )}
          >
            {typeLabel}
          </span>
        </div>
        {contactId && contactName && (
          <Link
            href={`/contacts/${contactId}`}
            className="mt-0.5 block text-xs text-primary hover:underline"
          >
            {contactName}
          </Link>
        )}
        {description && (
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
            {description}
          </p>
        )}
        {due && (
          <p
            className={cn(
              "mt-1 text-xs",
              due.overdue
                ? "font-medium text-amber-700 dark:text-amber-300"
                : "text-muted-foreground"
            )}
          >
            {due.text}
          </p>
        )}
      </div>
      <ReminderActions id={id} />
    </div>
  );
}
