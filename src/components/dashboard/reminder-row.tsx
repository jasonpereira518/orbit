"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { formatDistanceToNow } from "date-fns";
import { Copy, Sparkles } from "lucide-react";
import { toast } from "@/lib/toast";
import { draftFollowUpResponse } from "@/actions/reminders";
import { ReminderActions } from "@/components/dashboard/reminder-actions";
import { Button } from "@/components/ui/button";
import { ExpandableText } from "@/components/ui/expandable-text";
import { cn } from "@/lib/utils";

const TYPE_LABELS: Record<string, string> = {
  manual: "Task",
  capture: "From capture",
  post_meeting: "Post-meeting",
  generated: "Auto-generated",
  ai_suggested: "AI suggested",
};

const TYPE_STYLES: Record<string, string> = {
  manual: "bg-muted text-muted-foreground",
  capture: "bg-violet-500/15 text-violet-800 dark:text-violet-200",
  post_meeting: "bg-sky-500/15 text-sky-800 dark:text-sky-200",
  generated: "bg-muted text-muted-foreground",
  ai_suggested: "bg-violet-500/15 text-violet-800 dark:text-violet-200",
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
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState<string | null>(null);

  function generateDraft() {
    start(async () => {
      try {
        const result = await draftFollowUpResponse(id);
        setDraft(result.body);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not draft follow-up"
        );
      }
    });
  }

  return (
    <div className="rounded-xl border border-border/60 bg-card p-4">
      <div className="flex items-start justify-between gap-3">
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
            <ExpandableText text={description} lines={2} className="mt-1" />
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
          {contactId && (
            <div className="mt-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending}
                className="h-8"
                onClick={generateDraft}
              >
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                {pending
                  ? "Drafting…"
                  : draft
                    ? "Regenerate draft"
                    : "Draft follow-up"}
              </Button>
            </div>
          )}
        </div>
        <ReminderActions id={id} />
      </div>

      {draft && (
        <div className="mt-3 rounded-lg bg-muted/50 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Draft follow-up
            </p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => {
                void navigator.clipboard.writeText(draft);
                toast.success("Copied to clipboard");
              }}
            >
              <Copy className="mr-1 h-3 w-3" />
              Copy
            </Button>
          </div>
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">
            {draft}
          </p>
        </div>
      )}
    </div>
  );
}
