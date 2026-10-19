"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { BellRing, Pencil } from "lucide-react";
import Link from "next/link";
import { toast } from "@/lib/toast";
import { updateReminder } from "@/actions/reminders";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import type { Tone } from "@/lib/tone";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { friendlyError } from "@/lib/errors";

type ContactReminder = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  dueDate: Date | string | null;
};

/** The stored status, as a word a person would use, and the tone it is drawn in. */
const STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Open", tone: "info" },
  done: { label: "Done", tone: "success" },
  snoozed: { label: "Snoozed", tone: "neutral" },
};

function statusOf(status: string) {
  return STATUS[status] ?? { label: status.charAt(0).toUpperCase() + status.slice(1), tone: "neutral" as Tone };
}

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
          friendlyError(err, "That note didn’t save — try again?")
        );
      }
    });
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle as="h2">Reminders</CardTitle>
          <CardAction>
            <Link href="/reminders" className={buttonVariants({ variant: "outline", size: "sm" })}>
              All reminders
            </Link>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          {reminders.length === 0 ? (
            <EmptyState
              variant="plain"
              size="sm"
              icon={BellRing}
              title="No reminders yet"
              description="Schedule a follow-up and it will show up here."
            />
          ) : (
            reminders.map((r) => {
              const status = statusOf(r.status);
              return (
              <div
                key={r.id}
                className="flex items-start gap-2 rounded-xl border border-border-subtle p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">{r.title}</p>
                  {r.description?.trim() ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {r.description}
                    </p>
                  ) : null}
                  <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <Badge tone={status.tone} size="sm">
                      {status.label}
                    </Badge>
                    {r.dueDate ? <span>Due {format(new Date(r.dueDate), "MMM d")}</span> : null}
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
              );
            })
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
