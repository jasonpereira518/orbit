"use client";

/**
 * Adding an event: one field, its name or its link, and a date that starts as today.
 *
 * A link is read for the title, date, venue, host, cover and speakers (`enrichEventFromUrl`;
 * `canonical-url.ts` follows a ticket link to the public page first). A name is enough on its
 * own — the usual case is the morning after, adding an event Orbit did not find so its people
 * can be logged. So an event that has already happened opens its debrief straight away.
 *
 * The date is sent only for a bare name or when the user changed it: a link's page knows the
 * real date, and today's default must not overwrite it. Attendee lists are never fetched.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
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
import { toast } from "@/lib/toast";
import { createEvent, enrichEventFromUrl } from "@/actions/events";
import { UNTITLED_EVENT } from "@/lib/events/types";
import { friendlyError } from "@/lib/errors";

/** Today in the browser's zone, as the date input writes it. */
function todayYmd(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function looksLikeLink(value: string): boolean {
  return /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(value) && !/\s/.test(value);
}

export function AddEventDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [entry, setEntry] = useState("");
  const [date, setDate] = useState(todayYmd);
  const [dateTouched, setDateTouched] = useState(false);

  function reset() {
    setEntry("");
    setDate(todayYmd());
    setDateTouched(false);
  }

  function submit() {
    const value = entry.trim();
    if (!value) {
      toast.error("Give the event a name, or paste its link");
      return;
    }
    const isLink = looksLikeLink(value);
    const url = isLink ? (/^https?:\/\//i.test(value) ? value : `https://${value}`) : null;
    // A day with no time: UTC midnight and no zone, which the hero reads as a date alone.
    const sendDate = date && (!url || dateTouched) ? `${date}T00:00:00.000Z` : null;
    start(async () => {
      try {
        // A link with no name is fine: the server stores UNTITLED_EVENT and enrichment replaces
        // it with the page's own title, which is the whole point of pasting a link.
        const created = await createEvent({ title: url ? UNTITLED_EVENT : value, url, startsAt: sendDate });
        if (!created.ok) {
          toast.error(created.error);
          return;
        }
        const { id } = created.value;
        if (url) {
          // Awaited so the user lands on a page that already has its title and cover.
          const result = await enrichEventFromUrl(id, url);
          if (!result.ok && result.error) toast.error(result.error);
        }
        setOpen(false);
        reset();
        // Already happened (or happening today): the reason to add it now is to log who was there.
        router.push(date && date <= todayYmd() && (!url || dateTouched) ? `/capture?eventId=${id}` : `/events/${id}`);
        router.refresh();
      } catch (error) {
        toast.error(friendlyError(error, "Couldn’t add that event — try again?"));
      }
    });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden />
        Add event
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg" showCloseButton>
          <DialogHeader>
            <DialogTitle>Add an event</DialogTitle>
            <DialogDescription>
              Its name is enough. Paste a link instead and Orbit fills in the date, venue and
              artwork from the event page.
            </DialogDescription>
          </DialogHeader>

          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div>
              <Label htmlFor="event-entry">Event name or link</Label>
              <Input
                id="event-entry"
                value={entry}
                onChange={(e) => setEntry(e.target.value)}
                placeholder="Founders mixer, or https://partiful.com/e/…"
                className="mt-1"
                autoFocus
              />
            </div>
            <div>
              <Label htmlFor="event-date">Date</Label>
              <Input
                id="event-date"
                type="date"
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  setDateTouched(true);
                }}
                className="mt-1"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                Add event
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
