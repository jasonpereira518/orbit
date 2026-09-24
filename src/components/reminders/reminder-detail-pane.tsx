"use client";

import Link from "next/link";
import { IntentLink } from "@/components/ui/intent-link";
import { useMemo, useState, useTransition } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  Check,
  Coffee,
  Copy,
  FileText,
  Mail,
  NotebookPen,
  Phone,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { draftFollowUpResponse } from "@/actions/reminders";
import { Button, buttonVariants } from "@/components/ui/button";
import { ReminderFormFields } from "@/components/reminders/reminder-form-dialog";
import { ReminderSnoozeMenu } from "@/components/reminders/reminder-snooze-menu";
import { friendlyError } from "@/lib/errors";
import { dueLabelFor } from "@/lib/reminder-due-bucket";
import { reminderTypeLabel, reminderTypeStyle } from "@/lib/reminder-display";
import type { ReminderRow } from "@/lib/reminders-page";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * Everything about one reminder, editable in place: the fields, the person it's about,
 * where it came from, and a drafted follow-up. The same component fills the inline pane
 * on wide screens and the sheet on narrow ones.
 */
export function ReminderDetailPane({
  item,
  today,
  lists,
  onClose,
  onDone,
  onReopen,
  onSnooze,
  onDelete,
  snoozeOpen,
  onSnoozeOpenChange,
}: {
  item: ReminderRow;
  today: string;
  lists: Array<{ id: string; name: string }>;
  onClose: () => void;
  onDone: (id: string) => void;
  onReopen: (id: string) => void;
  onSnooze: (id: string, ymd: string, label: string) => void;
  onDelete: (id: string) => void;
  snoozeOpen: boolean;
  onSnoozeOpenChange: (open: boolean) => void;
}) {
  const due = dueLabelFor(item.dueDay, today);
  // Bumped by Cancel: remounting the form is how its edits are discarded.
  const [formKey, setFormKey] = useState(0);
  const isDone = item.status === "done";

  // Stable while the row is unchanged: the form re-initializes whenever `initial` changes
  // identity, and a new object on every parent render would wipe what's being typed.
  const initial = useMemo(
    () => ({
      id: item.id,
      title: item.title,
      description: item.description,
      dueDate: item.dueDate,
      listId: item.listId,
      contactId: item.contactId,
      contactName: item.contactName,
      actionKind: item.actionKind,
    }),
    [item]
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 py-2 pointer-coarse:gap-4">
        <h2 className="sr-only">Reminder details</h2>
        {!isDone && (
          <Button size="sm" variant="ghost" className="tap-target relative h-7 gap-1.5 px-2 text-xs" onClick={() => onDone(item.id)}>
            <Check className="size-3.5" /> Done
          </Button>
        )}
        {isDone && (
          <Button size="sm" variant="ghost" className="tap-target relative h-7 gap-1.5 px-2 text-xs" onClick={() => onReopen(item.id)}>
            <RotateCcw className="size-3.5" /> Reopen
          </Button>
        )}
        {!isDone && (
          <ReminderSnoozeMenu
            today={today}
            open={snoozeOpen}
            onOpenChange={onSnoozeOpenChange}
            onPick={(ymd, label) => onSnooze(item.id, ymd, label)}
            triggerLabel="Snooze"
            align="start"
          />
        )}
        <div className="flex-1" />
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Delete reminder"
          title="Delete (#)"
          className="tap-target relative text-muted-foreground hover:text-destructive"
          onClick={() => onDelete(item.id)}
        >
          <Trash2 className="size-3.5" />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Close details" title="Close (Esc)" className="tap-target relative" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 basis-0 space-y-5 overflow-y-auto overscroll-contain px-4 py-4">
        {due && (
          <p
            className={cn(
              "text-xs font-medium",
              due.bucket === "overdue" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"
            )}
          >
            {due.bucket === "overdue" || due.bucket === "today" || due.bucket === "tomorrow"
              ? due.text
              : `Due ${due.text}`}
          </p>
        )}

        <ReminderFormFields
          key={formKey}
          open
          onClose={() => {}}
          onCancel={() => setFormKey((k) => k + 1)}
          mode="edit"
          lists={lists}
          defaultListId={item.listId}
          initial={initial}
          idPrefix={`reminder-pane-${item.id}`}
          autoFocusTitle={false}
          compact
        />

        {item.contactId && <ContactSection item={item} />}
        <ProvenanceSection item={item} />
      </div>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

function ContactSection({ item }: { item: ReminderRow }) {
  const [drafting, start] = useTransition();
  const [draft, setDraft] = useState<string | null>(null);
  const action = cn(buttonVariants({ variant: "outline", size: "sm" }), "h-8 gap-1.5");
  const showDraft =
    item.actionKind === "follow_up" || item.actionKind === "email" || item.actionKind === "task";

  function generate() {
    start(async () => {
      try {
        const result = await draftFollowUpResponse(item.id);
        setDraft(result.body);
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t draft that follow-up — try again?"));
      }
    });
  }

  return (
    <section aria-labelledby={`contact-${item.id}`}>
      <SectionHeading>
        <span id={`contact-${item.id}`}>Person</span>
      </SectionHeading>
      <div className="rounded-xl border border-border/70 p-3">
        <IntentLink href={`/contacts/${item.contactId}`} className="text-sm font-medium text-primary hover:underline">
          {item.contactName ?? "Linked contact"}
        </IntentLink>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {item.contactLastTouch
            ? `Last in touch ${formatDistanceToNow(new Date(item.contactLastTouch), { addSuffix: true })}`
            : "No logged conversations yet"}
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Link href={`/capture?contactId=${item.contactId}`} className={action}>
            {item.actionKind === "meet" ? <Coffee className="size-3.5" /> : <NotebookPen className="size-3.5" />}
            {item.actionKind === "meet" ? "Log meeting" : "Log"}
          </Link>
          {item.contactPhone && (
            <a href={`tel:${item.contactPhone}`} className={action}>
              <Phone className="size-3.5" /> Call
            </a>
          )}
          {item.contactEmail && (
            <a
              href={`mailto:${item.contactEmail}?subject=${encodeURIComponent(item.title)}`}
              className={action}
            >
              <Mail className="size-3.5" /> Email
            </a>
          )}
          {showDraft && (
            <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5" disabled={drafting} onClick={generate}>
              <Sparkles className="size-3.5" />
              {drafting ? "Drafting…" : draft ? "Redraft" : "Draft follow-up"}
            </Button>
          )}
        </div>
        {draft && (
          <div className="mt-3 rounded-lg bg-muted/50 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Draft</p>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-xs"
                onClick={() => {
                  void navigator.clipboard.writeText(draft);
                  toast.success("Copied to clipboard", { keep: false });
                }}
              >
                <Copy className="size-3" /> Copy
              </Button>
            </div>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{draft}</p>
          </div>
        )}
      </div>
    </section>
  );
}

function ProvenanceSection({ item }: { item: ReminderRow }) {
  const label = reminderTypeLabel(item.reminderType, item.noteBatchId);
  const hasDetail = item.noteBatchId || item.sourceExcerpt || item.origin === "implied";
  if (!hasDetail && item.reminderType === "manual") return null;

  return (
    <section aria-labelledby={`source-${item.id}`}>
      <SectionHeading>
        <span id={`source-${item.id}`}>Where it came from</span>
      </SectionHeading>
      <div className="space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
              reminderTypeStyle(item.reminderType)
            )}
          >
            {label}
          </span>
          {item.origin === "implied" && (
            <span
              className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
              title="Orbit inferred this from what was discussed; the notes didn't say it outright."
            >
              Implied
              {item.confidenceScore != null ? ` · ${item.confidenceScore}%` : ""}
            </span>
          )}
        </div>
        {item.sourceExcerpt && (
          <blockquote className="rounded-lg border-l-2 border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {item.rawDatePhrase && (
              <span className="mb-1 block font-medium text-foreground">“{item.rawDatePhrase}”</span>
            )}
            {item.sourceExcerpt}
          </blockquote>
        )}
        {item.noteBatchId && (
          <Link
            href={`/capture/${item.noteBatchId}`}
            className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
          >
            <FileText className="size-3.5" /> Open the notes it came from
          </Link>
        )}
      </div>
    </section>
  );
}
