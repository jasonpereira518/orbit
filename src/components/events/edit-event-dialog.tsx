"use client";

/**
 * Editing an event by hand.
 *
 * ## Times are the venue's, in and out
 *
 * The hero renders an event in the wall clock the host published. This form has to read and
 * write that SAME clock, or editing anything would silently move the event: a
 * `datetime-local` input hands back `2026-03-04T18:00` with no zone, and `new Date()` on that
 * applies the browser's. Both directions go through `wall-clock.ts`, and what is sent to the
 * server is an ISO instant — never the raw input value.
 *
 * The zone is shown next to the fields rather than left implicit, because "18:00" means
 * nothing without it, and for an event whose host never published one there is nothing
 * honest to show but a note saying so.
 *
 * ## What is not here
 *
 * Cover art and accent colour belong to the palette control on the hero. Provider ids are
 * idempotency keys, not details. `timezone` is derived from the page and is displayed, not
 * typed — a free-text zone field would be a new way to get the arithmetic wrong.
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/lib/toast";
import { deleteEvent, updateEvent } from "@/actions/events";
import { fromWallClockInput, toWallClockInput, zoneLabel } from "@/lib/events/wall-clock";

/** Deliberately narrow: a client component must not reach `@/db`. */
export type EditableEvent = {
  id: string;
  title: string;
  description: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  timezone: string | null;
  venue: string | null;
  city: string | null;
  url: string | null;
  organizerName: string | null;
  organizerUrl: string | null;
  attendanceMode: "offline" | "online" | "mixed" | null;
};

/** `Select` cannot hold an empty value, so "unspecified" needs a token of its own. */
const UNSET = "unset";

export function EditEventDialog({
  event,
  onClose,
}: {
  event: EditableEvent;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [form, setForm] = useState({
    title: event.title,
    description: event.description ?? "",
    startsAt: toWallClockInput(event.startsAt, event.timezone),
    endsAt: toWallClockInput(event.endsAt, event.timezone),
    venue: event.venue ?? "",
    city: event.city ?? "",
    url: event.url ?? "",
    organizerName: event.organizerName ?? "",
    organizerUrl: event.organizerUrl ?? "",
    attendanceMode: (event.attendanceMode ?? UNSET) as string,
  });

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const zone = zoneLabel(event.timezone);
  const blank = (value: string) => (value.trim() ? value.trim() : null);

  function save() {
    if (!form.title.trim()) {
      toast.error("An event needs a name.");
      return;
    }
    start(async () => {
      try {
        await updateEvent(event.id, {
          title: form.title.trim(),
          description: blank(form.description),
          // Converted here, in the browser that knows the event's zone, and sent as an
          // instant. Sending the raw field would leave the server guessing the zone.
          startsAt: fromWallClockInput(form.startsAt, event.timezone)?.toISOString() ?? null,
          endsAt: fromWallClockInput(form.endsAt, event.timezone)?.toISOString() ?? null,
          venue: blank(form.venue),
          city: blank(form.city),
          url: blank(form.url),
          organizerName: blank(form.organizerName),
          organizerUrl: blank(form.organizerUrl),
          attendanceMode:
            form.attendanceMode === UNSET
              ? null
              : (form.attendanceMode as "offline" | "online" | "mixed"),
        });
        toast.success("Saved.");
        onClose();
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not save those changes.");
      }
    });
  }

  function remove() {
    start(async () => {
      try {
        await deleteEvent(event.id);
        toast.success("Event deleted. The people you connected are still in your contacts.");
        router.push("/events");
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not delete that event.");
      }
    });
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl" showCloseButton>
        <DialogHeader>
          <DialogTitle>Edit event</DialogTitle>
          <DialogDescription>
            Anything you change here is yours — a later refresh from the event page will show
            you what it wants to overwrite before it does.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="e-title">Name</Label>
            <Input id="e-title" value={form.title} onChange={(e) => set("title")(e.target.value)} className="mt-1" />
          </div>

          <div>
            <Label htmlFor="e-starts">Starts{zone ? ` (${zone})` : ""}</Label>
            <Input id="e-starts" type="datetime-local" value={form.startsAt} onChange={(e) => set("startsAt")(e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label htmlFor="e-ends">Ends{zone ? ` (${zone})` : ""}</Label>
            <Input id="e-ends" type="datetime-local" value={form.endsAt} onChange={(e) => set("endsAt")(e.target.value)} className="mt-1" />
          </div>
          {zone ? null : (
            <p className="text-xs text-muted-foreground sm:col-span-2">
              The event page never said which time zone these are in, so they are shown and
              saved exactly as written.
            </p>
          )}

          <div>
            <Label htmlFor="e-venue">Venue</Label>
            <Input id="e-venue" value={form.venue} onChange={(e) => set("venue")(e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label htmlFor="e-city">City</Label>
            <Input id="e-city" value={form.city} onChange={(e) => set("city")(e.target.value)} className="mt-1" />
          </div>

          <div>
            <Label htmlFor="e-host">Host</Label>
            <Input id="e-host" value={form.organizerName} onChange={(e) => set("organizerName")(e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label htmlFor="e-hostlink">Host link</Label>
            <Input id="e-hostlink" value={form.organizerUrl} onChange={(e) => set("organizerUrl")(e.target.value)} className="mt-1" />
          </div>

          <div className="sm:col-span-2">
            <Label htmlFor="e-url">Event link</Label>
            <Input id="e-url" value={form.url} onChange={(e) => set("url")(e.target.value)} className="mt-1" placeholder="https://…" />
          </div>

          <div className="sm:col-span-2">
            <Label htmlFor="e-mode">Format</Label>
            <Select value={form.attendanceMode} onValueChange={(v) => set("attendanceMode")(v ?? UNSET)}>
              <SelectTrigger id="e-mode" className="mt-1 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSET}>Not specified</SelectItem>
                <SelectItem value="offline">In person</SelectItem>
                <SelectItem value="online">Online</SelectItem>
                <SelectItem value="mixed">Hybrid</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="sm:col-span-2">
            <Label htmlFor="e-desc">Description</Label>
            <Textarea id="e-desc" value={form.description} onChange={(e) => set("description")(e.target.value)} className="mt-1" rows={3} />
          </div>
        </div>

        {confirmingDelete ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2.5">
            <p className="text-sm text-ink">Delete this event?</p>
            <p className="mt-1 text-xs text-muted-foreground">
              The guest list goes with it. Anyone you already added stays in your contacts, and
              this event stays on their timeline.
            </p>
            <div className="mt-2 flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)} disabled={pending}>
                Keep it
              </Button>
              <Button variant="destructive" size="sm" onClick={remove} disabled={pending}>
                {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                Delete event
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
            Delete
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
