"use client";

import Link from "next/link";
import { IntentLink } from "@/components/ui/intent-link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  Copy,
  Mail,
  Pencil,
  Phone,
  Sparkles,
  NotebookPen,
  Coffee,
} from "lucide-react";
import { runToastAction, toast } from "@/lib/toast";
import {
  draftFollowUpResponse,
  moveReminderToList,
} from "@/actions/reminders";
import type { ReminderActionKind } from "@/db/schema";
import { ACTION_KIND_LABELS } from "@/lib/reminder-action-kind";
import { dueDayOf, dueLabelFor, ymdInZone } from "@/lib/reminder-due-bucket";
import { reminderTypeLabel, reminderTypeStyle } from "@/lib/reminder-display";
import { ReminderDoneSnooze } from "@/components/reminders/reminder-done-snooze";
import { ReminderFormDialog } from "@/components/reminders/reminder-form-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ExpandableText } from "@/components/ui/expandable-text";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

/**
 * Due text on the viewer's calendar — the same rule the reminders page uses
 * (`reminder-due-bucket.ts`), so a card and a row never disagree about "overdue". Computed
 * in the browser's zone, which the server can't know; the span suppresses the hydration
 * warning for the one render where the two differ.
 */
function dueLabel(dueDate: Date | string | null | undefined) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const label = dueLabelFor(dueDayOf(dueDate, tz), ymdInZone(new Date(), tz));
  if (!label) return null;
  return {
    text: label.bucket === "overdue" || label.bucket === "today" || label.bucket === "tomorrow"
      ? label.text
      : `Due ${label.text}`,
    overdue: label.bucket === "overdue",
  };
}

export type ReminderCardListOption = {
  id: string;
  name: string;
};

export function ReminderCard({
  id,
  title,
  description,
  dueDate,
  reminderType,
  actionKind = "task",
  contactId,
  contactName,
  contactEmail,
  contactPhone,
  listId,
  lists,
  showListMove = false,
  compact = false,
  noteBatchId,
}: {
  id: string;
  title: string;
  description?: string | null;
  dueDate?: Date | string | null;
  reminderType: string;
  actionKind?: ReminderActionKind;
  contactId?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  listId?: string | null;
  lists?: ReminderCardListOption[];
  showListMove?: boolean;
  compact?: boolean;
  /** When this reminder came from a confirmed note paste, links the type chip back to its results page. */
  noteBatchId?: string | null;
}) {
  const due = dueLabel(dueDate);
  const typeLabel = reminderTypeLabel(reminderType, noteBatchId);
  const router = useRouter();
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState<string | null>(null);
  const [moving, startMove] = useTransition();
  const [editing, setEditing] = useState(false);

  function generateDraft() {
    start(async () => {
      try {
        const result = await draftFollowUpResponse(id);
        setDraft(result.body);
      } catch (err) {
        toast.error(
          friendlyError(err, TOAST_COPY.draftFollowUpFailed)
        );
      }
    });
  }

  const kindLabel = ACTION_KIND_LABELS[actionKind] ?? "Task";
  const showDraft =
    actionKind === "follow_up" ||
    actionKind === "email" ||
    (Boolean(contactId) && actionKind === "task");

  const actionClass = cn(
    buttonVariants({ variant: "outline", size: "sm" }),
    "h-8"
  );

  return (
    <div className="rounded-xl border border-border-subtle bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">{title}</p>
            {noteBatchId ? (
              <Badge
                size="sm"
                className={cn("hover:underline", reminderTypeStyle(reminderType))}
                render={<Link href={`/capture/${noteBatchId}`} />}
              >
                {typeLabel}
              </Badge>
            ) : (
              <Badge size="sm" className={reminderTypeStyle(reminderType)}>
                {typeLabel}
              </Badge>
            )}
            {!compact && (
              <Badge tone="neutral" size="sm">
                {kindLabel}
              </Badge>
            )}
          </div>
          {contactId && contactName && (
            <IntentLink
              href={`/contacts/${contactId}`}
              className="mt-0.5 block text-xs text-primary hover:underline"
            >
              {contactName}
            </IntentLink>
          )}
          {description && (
            <ExpandableText text={description} lines={2} className="mt-1" />
          )}
          {due && (
            // The label is the viewer's calendar day (see `dueLabel` above), which the
            // server can't know — it renders in its own zone — so the one hydrating render
            // may differ. That's a timezone difference, not a data mismatch.
            <p
              suppressHydrationWarning
              className={cn(
                "mt-1 text-xs",
                due.overdue
                  ? "font-medium text-warning"
                  : "text-muted-foreground"
              )}
            >
              {due.text}
            </p>
          )}

          <div className="mt-2 flex flex-wrap gap-1.5">
            {/* The contact name above is already a link to /contacts/{id}; a second
                "Open" button three lines below it was the same destination twice.
                For `meet` this used to render BOTH "Log" and "Log meeting" pointing
                at the identical /capture url — now one control, labelled for the
                kind. */}
            {contactId && (
              <Link
                href={`/capture?contactId=${contactId}`}
                className={actionClass}
              >
                {actionKind === "meet" ? (
                  <Coffee className="size-3.5" />
                ) : (
                  <NotebookPen className="size-3.5" />
                )}
                {actionKind === "meet" ? "Log meeting" : "Log"}
              </Link>
            )}
            {actionKind === "call" && contactPhone && (
              <a href={`tel:${contactPhone}`} className={actionClass}>
                <Phone className="size-3.5" />
                Call
              </a>
            )}
            {actionKind === "email" && contactEmail && (
              <a
                href={`mailto:${contactEmail}?subject=${encodeURIComponent(title)}`}
                className={actionClass}
              >
                <Mail className="size-3.5" />
                Email
              </a>
            )}
            {showDraft && contactId && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending}
                className="h-8"
                onClick={generateDraft}
              >
                <Sparkles className="size-3.5" />
                {pending
                  ? "Drafting…"
                  : draft
                    ? "Regenerate draft"
                    : "Draft follow-up"}
              </Button>
            )}
          </div>

          {showListMove && lists && lists.length > 1 && (
            <div className="mt-2">
              <label className="sr-only" htmlFor={`move-${id}`}>
                Move to list
              </label>
              <Select
                value={listId ?? ""}
                items={lists.map((l) => ({ value: l.id, label: l.name }))}
                disabled={moving}
                onValueChange={(v) => {
                  const next = typeof v === "string" ? v : "";
                  if (!next || next === listId) return;
                  const previous = listId;
                  const nextName = lists.find((l) => l.id === next)?.name;
                  startMove(() =>
                    runToastAction({
                      run: () => moveReminderToList(id, next),
                      success: nextName ? `Moved to ${nextName}` : "Moved",
                      failure: "Couldn’t move that reminder — try again?",
                      refresh: () => router.refresh(),
                      // The prior list is already on the card, so the inverse is just
                      // a move back. Offered only when there was a list to return to.
                      undo: () =>
                        previous ? () => moveReminderToList(id, previous) : null,
                    }).then(() => undefined)
                  );
                }}
              >
                <SelectTrigger id={`move-${id}`} size="sm" aria-label="Move to list">
                  <SelectValue placeholder="Move to list" />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false} className="p-1">
                  {lists.map((l) => (
                    <SelectItem key={l.id} value={l.id} className="py-1.5 pl-2">
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-start gap-1 pointer-coarse:gap-4">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="tap-target relative text-muted-foreground"
            aria-label="Edit reminder"
            onClick={() => setEditing(true)}
          >
            <Pencil className="size-3.5" />
          </Button>
          <ReminderDoneSnooze id={id} />
        </div>
      </div>

      <ReminderFormDialog
        open={editing}
        onOpenChange={setEditing}
        mode="edit"
        lists={lists ?? []}
        defaultListId={listId}
        initial={{
          id,
          title,
          description,
          dueDate,
          listId,
          contactId,
          contactName,
          actionKind,
        }}
      />

      {draft && (
        <div className="mt-3 rounded-lg border border-border-subtle bg-surface-inset p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Draft follow-up
            </p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => {
                void navigator.clipboard.writeText(draft);
                toast.success(TOAST_COPY.copied);
              }}
            >
              <Copy className="size-3" />
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
