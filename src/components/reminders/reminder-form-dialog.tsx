"use client";

import { useEffect, useState, useTransition } from "react";
import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import { createReminder, updateReminder } from "@/actions/reminders";
import type { ReminderActionKind } from "@/db/schema";
import {
  ACTION_KIND_LABELS,
  REMINDER_ACTION_KINDS,
  inferReminderActionKind,
} from "@/lib/reminder-action-kind";
import { DatePickerButton } from "@/components/ui/date-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ReminderContactPicker } from "@/components/reminders/reminder-contact-picker";
import { dueDayOf, shortDayLabel } from "@/lib/reminder-due-bucket";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

export type ReminderFormValues = {
  id?: string;
  title?: string;
  description?: string | null;
  dueDate?: Date | string | null;
  listId?: string | null;
  contactId?: string | null;
  /** Shown on the contact picker before anything is searched. */
  contactName?: string | null;
  actionKind?: ReminderActionKind | "auto";
};

/**
 * The due date as the picker's YYYY-MM-DD. A date-only value keeps its own date (see
 * `dueDayOf`); converting UTC midnight into a zone west of UTC showed the day before.
 */
function dueToInput(value: Date | string | null | undefined): string {
  if (!value) return "";
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return dueDayOf(value, tz) ?? "";
}

export function ReminderFormFields({
  open,
  onClose,
  mode,
  lists,
  defaultListId,
  initial,
  idPrefix = "reminder",
  autoFocusTitle = true,
  compact = false,
  onCancel,
}: {
  open: boolean;
  onClose: () => void;
  mode: "create" | "edit";
  lists: Array<{ id: string; name: string }>;
  defaultListId?: string | null;
  initial?: ReminderFormValues | null;
  idPrefix?: string;
  autoFocusTitle?: boolean;
  /** One column, for the narrow detail pane. */
  compact?: boolean;
  /** What Cancel does, when it isn't `onClose` — the detail pane discards edits instead. */
  onCancel?: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [selectedListId, setSelectedListId] = useState("");
  const [contact, setContact] = useState<{ id: string; name: string } | null>(null);
  const [actionKind, setActionKind] = useState<ReminderActionKind | "auto">(
    "auto"
  );

  useEffect(() => {
    if (!open) return;
    setTitle(initial?.title ?? "");
    setDescription(initial?.description?.trim() || "");
    setDueDate(dueToInput(initial?.dueDate));
    setSelectedListId(initial?.listId || defaultListId || lists[0]?.id || "");
    setContact(
      initial?.contactId
        ? { id: initial.contactId, name: initial.contactName?.trim() || "Linked contact" }
        : null
    );
    setActionKind(
      mode === "edit"
        ? initial?.actionKind && initial.actionKind !== "auto"
          ? initial.actionKind
          : "task"
        : "auto"
    );
  }, [open, initial, defaultListId, lists, mode]);

  function submit() {
    const trimmed = title.trim();
    if (!trimmed) {
      toast.error("Give it a title first");
      return;
    }
    start(async () => {
      try {
        const kind =
          actionKind === "auto"
            ? inferReminderActionKind({
                title: trimmed,
                description,
                contactId: contact?.id ?? null,
              })
            : actionKind;

        if (mode === "edit") {
          if (!initial?.id) throw new Error("Reminder not found");
          await updateReminder(initial.id, {
            title: trimmed,
            description: description.trim() || null,
            dueDate: dueDate || null,
            ...(lists.length > 0 ? { listId: selectedListId || null } : {}),
            contactId: contact?.id ?? null,
            actionKind: kind,
          });
          toast.success("Reminder updated");
        } else {
          await createReminder({
            title: trimmed,
            description: description.trim() || undefined,
            dueDate: dueDate || undefined,
            listId: selectedListId || undefined,
            contactId: contact?.id || undefined,
            actionKind: kind,
          });
          toast.success(TOAST_COPY.reminderSet);
        }
        onClose();
        router.refresh();
      } catch (err) {
        toast.error(
          friendlyError(
            err,
            mode === "edit"
              ? "Couldn’t update that reminder — try again?"
              : "Couldn’t create that reminder — try again?"
          )
        );
      }
    });
  }

  const kindItems = [
    ...(mode === "create" ? [{ value: "auto", label: "Auto-detect" }] : []),
    ...REMINDER_ACTION_KINDS.map((k) => ({ value: k, label: ACTION_KIND_LABELS[k] })),
  ];
  const listItems = lists.map((l) => ({ value: l.id, label: l.name }));

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-title`}>Title</Label>
        <Input
          id={`${idPrefix}-title`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
          placeholder="Call Alex about intro"
          autoFocus={autoFocusTitle}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-notes`}>Notes</Label>
        <Textarea
          id={`${idPrefix}-notes`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={compact ? 3 : 2}
          placeholder="Optional context"
        />
      </div>

      <div className={compact ? "grid gap-3" : "grid gap-3 sm:grid-cols-2"}>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-due`}>Due date</Label>
          <div className="flex items-center gap-1.5">
            <DatePickerButton
              value={dueDate || null}
              onSelect={setDueDate}
              onClear={() => setDueDate("")}
              label={dueDate ? shortDayLabel(dueDate) : "No date"}
              className="h-8 flex-1 justify-start font-normal"
            />
            {dueDate ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="tap-target relative"
                aria-label="Clear due date"
                onClick={() => setDueDate("")}
              >
                <X className="size-3.5" />
              </Button>
            ) : null}
          </div>
        </div>
        {lists.length > 0 ? (
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-list`}>List</Label>
            <Select
              value={selectedListId}
              onValueChange={(v) => setSelectedListId(String(v ?? ""))}
              items={listItems}
            >
              <SelectTrigger id={`${idPrefix}-list`} className="h-8 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false} className="p-1">
                {listItems.map((item) => (
                  <SelectItem key={item.value} value={item.value} className="py-1.5 pl-2">
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-contact`}>Contact</Label>
          <ReminderContactPicker
            id={`${idPrefix}-contact`}
            value={contact}
            onChange={setContact}
            placeholder="None"
            triggerClassName="w-full"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-kind`}>Action type</Label>
          <Select
            value={actionKind}
            onValueChange={(v) => setActionKind((v ?? "auto") as ReminderActionKind | "auto")}
            items={kindItems}
          >
            <SelectTrigger id={`${idPrefix}-kind`} className="h-8 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false} className="p-1">
              {kindItems.map((item) => (
                <SelectItem key={item.value} value={item.value} className="py-1.5 pl-2">
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={onCancel ?? onClose}
        >
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={pending} onClick={submit}>
          {pending
            ? "Saving…"
            : mode === "edit"
              ? "Save changes"
              : "Add reminder"}
        </Button>
      </div>
    </div>
  );
}

export function ReminderFormDialog({
  open,
  onOpenChange,
  mode,
  lists,
  defaultListId,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  lists: Array<{ id: string; name: string }>;
  defaultListId?: string | null;
  initial?: ReminderFormValues | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" showCloseButton>
        <DialogHeader>
          <DialogTitle>
            {mode === "edit" ? "Edit reminder" : "New reminder"}
          </DialogTitle>
        </DialogHeader>
        <ReminderFormFields
          open={open}
          onClose={() => onOpenChange(false)}
          mode={mode}
          lists={lists}
          defaultListId={defaultListId}
          initial={initial}
          idPrefix="reminder-edit"
        />
      </DialogContent>
    </Dialog>
  );
}
