"use client";

/**
 * Correcting one person on the roster, and removing them.
 *
 * Every field here was already stored and, for two of them, never shown anywhere: a parsed
 * `linkedinUrl` and `xHandle` had no rendering in the roster at all, so this dialog is the
 * first time they are visible. `email` was reachable only when a row had no title or company,
 * because the row's second line is an `||` chain.
 *
 * ## The two refusals
 *
 * Saving can come back with `ok: false`, and both cases are the user's to resolve rather than
 * ours to paper over:
 *
 *   - `empty` — nothing identifying is left. A roster row has to be SOMEBODY.
 *   - `collision` — another row on this roster already claims that identity. Merging is
 *     deliberately not offered: silently folding two rows together is the kind of wrong that
 *     cannot be undone. Instead the other person is named, and deleting one of them is the
 *     way out — which is why Delete lives in this same dialog.
 *
 * Delete removes the ROSTER row only. If the person was connected, their contact and this
 * event's interaction stay, and the copy says so — taking someone off a guest list is not a
 * claim that you never met them.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { deleteAttendee, updateAttendee } from "@/actions/events";
import type { AttendeeRole, RosterRow } from "@/lib/events/types";

/** `Select` cannot hold an empty value, so "no role" needs a token of its own. */
const NO_ROLE = "none";

export function EditAttendeeDialog({
  eventId,
  row,
  onClose,
}: {
  eventId: string;
  row: RosterRow;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [form, setForm] = useState({
    fullName: row.fullName ?? "",
    email: row.email ?? "",
    company: row.company ?? "",
    title: row.title ?? "",
    linkedinUrl: row.linkedinUrl ?? "",
    xHandle: row.xHandle ?? "",
    attendeeRole: (row.attendeeRole ?? NO_ROLE) as AttendeeRole | typeof NO_ROLE,
  });

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const who = row.fullName ?? row.email ?? "this person";

  function save() {
    start(async () => {
      try {
        const result = await updateAttendee(eventId, row.id, {
          fullName: form.fullName,
          email: form.email,
          company: form.company,
          title: form.title,
          linkedinUrl: form.linkedinUrl,
          xHandle: form.xHandle,
          attendeeRole: form.attendeeRole === NO_ROLE ? null : form.attendeeRole,
        });

        if (result.ok) {
          toast.success("Saved");
          onClose();
          router.refresh();
          return;
        }
        if (result.reason === "collision") {
          toast.error(
            `${result.otherName ?? "Someone else"} is already on this roster with those details — delete one of the two rows, then try again`
          );
          return;
        }
        if (result.reason === "empty") {
          toast.error("Give them a name, an email, a LinkedIn URL or a handle");
          return;
        }
        toast.error("That person is no longer on this roster");
      } catch (error) {
        toast.error(friendlyError(error, "Couldn’t save those changes — try again?"));
      }
    });
  }

  function remove() {
    start(async () => {
      try {
        await deleteAttendee(eventId, row.id);
        toast.success(
          row.contactId
            ? "Removed from this roster — they’re still in your contacts"
            : "Removed from this roster"
        );
        onClose();
        router.refresh();
      } catch (error) {
        toast.error(friendlyError(error, "Couldn’t remove that person — try again?"));
      }
    });
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="sm:max-w-lg" showCloseButton>
        <DialogHeader>
          <DialogTitle>Edit {who}</DialogTitle>
          <DialogDescription>
            Fix anything the import got wrong. These details are what Orbit matches on when
            you add someone to your contacts.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="a-name" label="Name" value={form.fullName} onChange={set("fullName")} />
          <Field id="a-email" label="Email" value={form.email} onChange={set("email")} type="email" />
          <Field id="a-company" label="Company" value={form.company} onChange={set("company")} />
          <Field id="a-title" label="Title" value={form.title} onChange={set("title")} />
          <Field
            id="a-linkedin"
            label="LinkedIn"
            value={form.linkedinUrl}
            onChange={set("linkedinUrl")}
            placeholder="https://www.linkedin.com/in/…"
          />
          <Field id="a-handle" label="X handle" value={form.xHandle} onChange={set("xHandle")} placeholder="without the @" />
          <div className="sm:col-span-2">
            <Label htmlFor="a-role">Role at this event</Label>
            <Select
              value={form.attendeeRole}
              onValueChange={(value) => set("attendeeRole")(value ?? NO_ROLE)}
            >
              <SelectTrigger id="a-role" className="mt-1 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_ROLE}>Attendee</SelectItem>
                <SelectItem value="host">Host</SelectItem>
                <SelectItem value="speaker">Speaker</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {confirmingDelete ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2.5">
            <p className="text-sm text-ink">Remove {who} from this roster?</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {row.contactId
                ? "They stay in your contacts, and this event stays on their timeline. Only the roster row goes."
                : "This cannot be undone, but you can always paste them back in."}
            </p>
            <div className="mt-2 flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)} disabled={pending}>
                Keep them
              </Button>
              <Button variant="destructive" size="sm" onClick={remove} disabled={pending}>
                {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                Remove
              </Button>
            </div>
          </div>
        ) : null}

        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmingDelete(true)}
            disabled={pending || confirmingDelete}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-4" aria-hidden />
            Remove
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={save} disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1"
      />
    </div>
  );
}
