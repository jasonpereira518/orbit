"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import { createReminder, updateReminder } from "@/actions/reminders";
import { listContacts } from "@/actions/contacts";
import type { ReminderActionKind } from "@/db/schema";
import {
  ACTION_KIND_LABELS,
  REMINDER_ACTION_KINDS,
  inferReminderActionKind,
} from "@/lib/reminder-action-kind";
import { toLocalYmd } from "@/components/ui/date-picker";
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

type ContactOption = {
  id: string;
  fullName: string;
  preferredName: string | null;
};

export type ReminderFormValues = {
  id?: string;
  title?: string;
  description?: string | null;
  dueDate?: Date | string | null;
  listId?: string | null;
  contactId?: string | null;
  actionKind?: ReminderActionKind | "auto";
};

function dueToInput(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return toLocalYmd(date);
}

export function ReminderFormFields({
  open,
  onClose,
  mode,
  lists,
  defaultListId,
  initial,
  idPrefix = "reminder",
}: {
  open: boolean;
  onClose: () => void;
  mode: "create" | "edit";
  lists: Array<{ id: string; name: string }>;
  defaultListId?: string | null;
  initial?: ReminderFormValues | null;
  idPrefix?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [selectedListId, setSelectedListId] = useState("");
  const [contactId, setContactId] = useState("");
  const [actionKind, setActionKind] = useState<ReminderActionKind | "auto">(
    "auto"
  );
  const [contacts, setContacts] = useState<ContactOption[]>([]);

  useEffect(() => {
    if (!open) return;
    setTitle(initial?.title ?? "");
    setDescription(initial?.description?.trim() || "");
    setDueDate(dueToInput(initial?.dueDate));
    setSelectedListId(initial?.listId || defaultListId || lists[0]?.id || "");
    setContactId(initial?.contactId ?? "");
    setActionKind(
      mode === "edit"
        ? initial?.actionKind && initial.actionKind !== "auto"
          ? initial.actionKind
          : "task"
        : "auto"
    );
  }, [open, initial, defaultListId, lists, mode]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listContacts()
      .then((rows) => {
        if (cancelled) return;
        setContacts(
          rows.map((c) => ({
            id: c.id,
            fullName: c.fullName,
            preferredName: c.preferredName,
          }))
        );
      })
      .catch(() => {
        if (!cancelled) toast.error("Could not load contacts");
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  function submit() {
    const trimmed = title.trim();
    if (!trimmed) {
      toast.error("Title is required");
      return;
    }
    start(async () => {
      try {
        const kind =
          actionKind === "auto"
            ? inferReminderActionKind({
                title: trimmed,
                description,
                contactId: contactId || null,
              })
            : actionKind;

        if (mode === "edit") {
          if (!initial?.id) throw new Error("Reminder not found");
          await updateReminder(initial.id, {
            title: trimmed,
            description: description.trim() || null,
            dueDate: dueDate || null,
            ...(lists.length > 0 ? { listId: selectedListId || null } : {}),
            contactId: contactId || null,
            actionKind: kind,
          });
          toast.success("Reminder updated");
        } else {
          await createReminder({
            title: trimmed,
            description: description.trim() || undefined,
            dueDate: dueDate || undefined,
            listId: selectedListId || undefined,
            contactId: contactId || undefined,
            actionKind: kind,
          });
          toast.success("Reminder created");
        }
        onClose();
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : mode === "edit"
              ? "Could not update reminder"
              : "Could not create reminder"
        );
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-title`}>Title</Label>
        <Input
          id={`${idPrefix}-title`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Call Alex about intro"
          autoFocus
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-notes`}>Notes</Label>
        <Textarea
          id={`${idPrefix}-notes`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="Optional context"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-due`}>Due date</Label>
          <Input
            id={`${idPrefix}-due`}
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </div>
        {lists.length > 0 ? (
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-list`}>List</Label>
            <select
              id={`${idPrefix}-list`}
              className="flex h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm"
              value={selectedListId}
              onChange={(e) => setSelectedListId(e.target.value)}
            >
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-contact`}>Contact</Label>
          <select
            id={`${idPrefix}-contact`}
            className="flex h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm"
            value={contactId}
            onChange={(e) => setContactId(e.target.value)}
          >
            <option value="">None</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.preferredName?.trim() || c.fullName}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-kind`}>Action type</Label>
          <select
            id={`${idPrefix}-kind`}
            className="flex h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm"
            value={actionKind}
            onChange={(e) =>
              setActionKind(e.target.value as ReminderActionKind | "auto")
            }
          >
            {mode === "create" ? (
              <option value="auto">Auto-detect</option>
            ) : null}
            {REMINDER_ACTION_KINDS.map((k) => (
              <option key={k} value={k}>
                {ACTION_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={onClose}
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
