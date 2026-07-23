"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Pencil } from "lucide-react";
import { toast } from "@/lib/toast";
import { updateReminder } from "@/actions/reminders";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type ContactReminder = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  dueDate: Date | string | null;
};

export function ContactRemindersSection({
  reminders,
}: {
  reminders: ContactReminder[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<ContactReminder | null>(null);
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();

  function openEdit(reminder: ContactReminder) {
    setEditing(reminder);
    setNote(reminder.description?.trim() || "");
  }

  function saveNote() {
    if (!editing) return;
    start(async () => {
      try {
        const trimmed = note.trim();
        await updateReminder(editing.id, {
          description: trimmed || null,
        });
        toast.success(trimmed ? "Note saved" : "Note cleared");
        setEditing(null);
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not save note"
        );
      }
    });
  }

  return (
    <>
      <Card className="border-border/70 shadow-none">
        <CardHeader>
          <CardTitle>Reminders</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {reminders.length === 0 ? (
            <p className="text-sm text-muted-foreground">No reminders.</p>
          ) : (
            reminders.map((r) => (
              <div
                key={r.id}
                className="flex items-start gap-2 rounded-xl border border-border/60 p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-primary">{r.title}</p>
                  {r.description?.trim() ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {r.description}
                    </p>
                  ) : null}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {r.status}
                    {r.dueDate
                      ? ` · due ${format(new Date(r.dueDate), "MMM d")}`
                      : ""}
                  </p>
                </div>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="shrink-0 text-muted-foreground"
                  aria-label="Edit reminder note"
                  onClick={() => openEdit(r)}
                >
                  <Pencil className="size-3.5" />
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Dialog
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit note</DialogTitle>
          </DialogHeader>
          {editing ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{editing.title}</p>
              <div className="space-y-2">
                <Label htmlFor="reminder-note">Note</Label>
                <Textarea
                  id="reminder-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={4}
                  placeholder="Add context for this reminder…"
                  autoFocus
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => setEditing(null)}
            >
              Cancel
            </Button>
            <Button type="button" disabled={pending} onClick={saveNote}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
