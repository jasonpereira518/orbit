"use client";

/**
 * The hero's Edit and Refresh controls.
 *
 * A small client island so `EventHero` can stay a server component — it renders the cover,
 * the theme variables and the dates, none of which need the browser.
 *
 * ## Why refreshing is two steps
 *
 * Enrichment only ever fills blanks, so a refresh that reused it would do nothing to an event
 * that already has details. Refresh therefore REPLACES, which makes it the one destructive
 * read in this feature — it can overwrite something the user typed by hand.
 *
 * So it previews first: fetch, diff, show exactly which fields would change and to what, and
 * write only on confirmation. The same shape as the roster's connect preview, for the same
 * reason. It costs a second fetch on confirm, because the server re-reads the page rather
 * than trusting a diff that has been round-tripped through a browser.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { previewResync, resyncEvent } from "@/actions/events";
import { EditEventDialog, type EditableEvent } from "./edit-event-dialog";

type Change = { field: string; label: string; from: string | null; to: string };

export function EventActions({ event }: { event: EditableEvent }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [changes, setChanges] = useState<Change[] | null>(null);

  function preview() {
    start(async () => {
      try {
        const result = await previewResync(event.id);
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        if (result.changes.length === 0) {
          // Not a failure, and not worth a dialog: the page still says what we already hold.
          toast.success("Already up to date with the event page");
          return;
        }
        setChanges(result.changes);
      } catch (error) {
        toast.error(friendlyError(error, "Couldn’t read that page — try again?"));
      }
    });
  }

  function apply() {
    start(async () => {
      try {
        const result = await resyncEvent(event.id);
        setChanges(null);
        if (!result.ok) {
          toast.error(result.error ?? "Couldn’t refresh from that page — try again?");
          return;
        }
        toast.success("Refreshed from the event page");
        router.refresh();
      } catch (error) {
        toast.error(friendlyError(error, "Couldn’t refresh from that page — try again?"));
      }
    });
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="xs" onClick={() => setEditing(true)}>
          <Pencil className="size-3.5" aria-hidden />
          Edit
        </Button>
        {/* Only offered when there is a page to refresh FROM. */}
        {event.url ? (
          <Button variant="ghost" size="xs" onClick={preview} disabled={pending}>
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="size-3.5" aria-hidden />
            )}
            Refresh
          </Button>
        ) : null}
      </div>

      {editing ? <EditEventDialog event={event} onClose={() => setEditing(false)} /> : null}

      {changes ? (
        <Dialog open onOpenChange={(next) => (next ? null : setChanges(null))}>
          <DialogContent className="sm:max-w-lg" showCloseButton>
            <DialogHeader>
              <DialogTitle>Refresh from the event page?</DialogTitle>
              <DialogDescription>
                This is everything that would change. Fields the page no longer mentions are
                left exactly as they are.
              </DialogDescription>
            </DialogHeader>

            <ul className="max-h-72 divide-y divide-border/70 overflow-y-auto rounded-xl border border-border/70">
              {changes.map((change) => (
                <li key={change.field} className="px-3 py-2 text-sm">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {change.label}
                  </p>
                  {change.from ? (
                    <p className="mt-0.5 text-muted-foreground line-through decoration-muted-foreground/50">
                      {change.from}
                    </p>
                  ) : null}
                  <p className="text-ink">{change.to}</p>
                </li>
              ))}
            </ul>

            <DialogFooter>
              <Button variant="ghost" onClick={() => setChanges(null)} disabled={pending}>
                Keep what I have
              </Button>
              <Button onClick={apply} disabled={pending}>
                {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                Apply {changes.length} {changes.length === 1 ? "change" : "changes"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
