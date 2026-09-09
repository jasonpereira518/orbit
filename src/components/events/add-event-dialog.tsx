"use client";

/**
 * Adding an event, usually by pasting its link.
 *
 * The URL is the fast path: `enrichEventFromUrl` reads the public page for the title, date,
 * venue, cover art and theme colour. It reads DETAILS ONLY — guest lists are never scraped —
 * and the copy says so, because a user who pasted a Luma link would reasonably expect the
 * guests to come with it.
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

export function AddEventDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [startsAt, setStartsAt] = useState("");

  function submit() {
    const name = title.trim() || (url.trim() ? "Untitled event" : "");
    if (!name) {
      toast.error("Give the event a name, or paste its link.");
      return;
    }
    start(async () => {
      try {
        const { id } = await createEvent({
          title: name,
          url: url.trim() || null,
          startsAt: startsAt || null,
        });
        if (url.trim()) {
          // Awaited here (rather than left to the background pass `createEvent` also kicks)
          // so the user lands on a page that already has its title and cover.
          const result = await enrichEventFromUrl(id, url.trim());
          if (!result.ok && result.error) toast.error(result.error);
        }
        setOpen(false);
        setTitle("");
        setUrl("");
        setStartsAt("");
        router.push(`/events/${id}`);
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not add that event.");
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
              Paste the event link and Orbit will pull in the title, date, venue and artwork.
              Guest lists are never fetched — you add those yourself.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <Label htmlFor="event-url">Event link</Label>
              <Input
                id="event-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://lu.ma/..."
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="event-title">Name</Label>
              <Input
                id="event-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Deep Learning Summit"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="event-date">Date</Label>
              <Input
                id="event-date"
                type="date"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                className="mt-1"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Add event
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
