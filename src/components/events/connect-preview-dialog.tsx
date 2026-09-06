"use client";

/**
 * The dry run, shown before anything is written.
 *
 * A pasted roster is frequently name-only, and a conference is exactly where two different
 * "Sarah Chen"s turn up. `connect.ts` therefore uses the standard 0.85 merge bar rather than
 * the calendar path's 0.6, which means a bare name match CREATES rather than merges — the
 * safe direction, since a duplicate can be merged later but a wrong merge cannot be undone.
 *
 * This dialog is what makes that honest: the user sees which people will attach to an
 * existing contact and which will be new, before committing, and can go back and deselect.
 */
import { Loader2, UserCheck, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type PreviewRow = {
  attendeeId: string;
  name: string;
  outcome: "match" | "create";
  matchedContactId: string | null;
  matchedContactName: string | null;
  confidence: number;
};

export function ConnectPreviewDialog({
  rows,
  pending,
  onCancel,
  onConfirm,
}: {
  rows: PreviewRow[];
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const matches = rows.filter((r) => r.outcome === "match");
  const creates = rows.filter((r) => r.outcome === "create");

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-lg" showCloseButton>
        <DialogHeader>
          <DialogTitle>Add {rows.length} to your connections</DialogTitle>
          <DialogDescription>
            {creates.length} will be added as new people; {matches.length} already in your
            network will get this event on their timeline.
          </DialogDescription>
        </DialogHeader>

        <ul className="max-h-72 space-y-1 overflow-y-auto text-sm">
          {rows.map((row) => (
            <li
              key={row.attendeeId}
              className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-muted/60"
            >
              <span className="truncate text-ink">{row.name}</span>
              {row.outcome === "match" ? (
                <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <UserCheck className="size-3.5" aria-hidden />
                  {/* Naming the matched contact is the point: it is the user's only chance to
                      spot "that is a different Sarah Chen" before the two are joined. */}
                  matches {row.matchedContactName ?? "an existing contact"}
                </span>
              ) : (
                <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <UserPlus className="size-3.5" aria-hidden />
                  new contact
                </span>
              )}
            </li>
          ))}
        </ul>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Back
          </Button>
          <Button onClick={onConfirm} disabled={pending}>
            {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Add {rows.length}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
