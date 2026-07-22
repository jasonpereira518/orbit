"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import { createReminder } from "@/actions/reminders";
import { listContacts } from "@/actions/contacts";
import type { ReminderActionKind } from "@/db/schema";
import {
  ACTION_KIND_LABELS,
  REMINDER_ACTION_KINDS,
  inferReminderActionKind,
} from "@/lib/reminder-action-kind";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type ContactOption = {
  id: string;
  fullName: string;
  preferredName: string | null;
};

export function ReminderCreateForm({
  listId,
  lists,
}: {
  listId: string | null;
  lists: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [selectedListId, setSelectedListId] = useState(listId ?? "");
  const [contactId, setContactId] = useState("");
  const [actionKind, setActionKind] = useState<ReminderActionKind | "auto">(
    "auto"
  );
  const [contacts, setContacts] = useState<ContactOption[]>([]);

  useEffect(() => {
    setSelectedListId(listId ?? "");
  }, [listId]);

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

  function reset() {
    setTitle("");
    setDescription("");
    setDueDate("");
    setContactId("");
    setActionKind("auto");
  }

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
        await createReminder({
          title: trimmed,
          description: description.trim() || undefined,
          dueDate: dueDate || undefined,
          listId: selectedListId || undefined,
          contactId: contactId || undefined,
          actionKind: kind,
        });
        toast.success("Reminder created");
        reset();
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not create reminder"
        );
      }
    });
  }

  if (!open) {
    return (
      <Button type="button" onClick={() => setOpen(true)}>
        New reminder
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-border/60 bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">New reminder</h2>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpen(false);
            reset();
          }}
        >
          Cancel
        </Button>
      </div>

      <div className="space-y-2">
        <Label htmlFor="reminder-title">Title</Label>
        <Input
          id="reminder-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Call Alex about intro"
          autoFocus
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="reminder-notes">Notes</Label>
        <Textarea
          id="reminder-notes"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="Optional context"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="reminder-due">Due date</Label>
          <Input
            id="reminder-due"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="reminder-list">List</Label>
          <select
            id="reminder-list"
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
        <div className="space-y-2">
          <Label htmlFor="reminder-contact">Contact</Label>
          <select
            id="reminder-contact"
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
          <Label htmlFor="reminder-kind">Action type</Label>
          <select
            id="reminder-kind"
            className="flex h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm"
            value={actionKind}
            onChange={(e) =>
              setActionKind(e.target.value as ReminderActionKind | "auto")
            }
          >
            <option value="auto">Auto-detect</option>
            {REMINDER_ACTION_KINDS.map((k) => (
              <option key={k} value={k}>
                {ACTION_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex justify-end">
        <Button type="button" disabled={pending} onClick={submit}>
          {pending ? "Saving…" : "Add reminder"}
        </Button>
      </div>
    </div>
  );
}
