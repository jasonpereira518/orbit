"use client";

/**
 * The roster, and the "who did I actually speak to" checklist.
 *
 * This is where the feature earns its keep: an attendee list is inert data until someone
 * marks the handful of people worth keeping. Connecting is deliberately a two-step —
 * preview, then commit — because a name-only match is genuinely ambiguous and the user is
 * the only one who can resolve it. See `src/lib/events/connect.ts` for why the threshold is
 * 0.85 rather than the calendar path's 0.6.
 *
 * Imports only pure modules from `@/lib/events/*` (types) plus the server actions. It must
 * never reach `store.ts` or anything touching `@/db` — `src/lib/surfaces.ts` records that a
 * client component transitively importing the database fails the build with a `node:fs`
 * chunking error naming neither file.
 */
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, Loader2, Search, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";
import {
  addSpokenToConnections,
  previewConnectAttendees,
  removeSpokenToConnection,
} from "@/actions/events";
import type { ConnectSummary, RosterRow } from "@/lib/events/types";
import { ConnectPreviewDialog, type PreviewRow } from "./connect-preview-dialog";
import { IngestResultCard } from "./ingest-result-card";

const SOURCE_LABEL: Record<RosterRow["source"], string> = {
  paste: "Pasted",
  csv: "CSV",
  screenshot: "Screenshot",
  luma: "Luma",
  eventbrite: "Eventbrite",
};

export function AttendeeRoster({
  eventId,
  rows,
}: {
  eventId: string;
  rows: RosterRow[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [query, setQuery] = useState("");
  const [hideConnected, setHideConnected] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [summary, setSummary] = useState<(ConnectSummary & { remaining: number }) | null>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (hideConnected && row.contactId) return false;
      if (!needle) return true;
      return [row.fullName, row.email, row.company, row.title]
        .filter(Boolean)
        .some((field) => field!.toLowerCase().includes(needle));
    });
  }, [rows, query, hideConnected]);

  // Already-connected people are excluded from every bulk action: connecting them again is a
  // no-op, so offering it would be a button that claims to do something and does not.
  const selectable = visible.filter((row) => !row.contactId);
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      if (allSelected) {
        const next = new Set(prev);
        selectable.forEach((r) => next.delete(r.id));
        return next;
      }
      return new Set([...prev, ...selectable.map((r) => r.id)]);
    });
  }

  function openPreview() {
    const ids = [...selected];
    if (ids.length === 0) return;
    start(async () => {
      try {
        setPreview(await previewConnectAttendees(eventId, ids));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not check those people.");
      }
    });
  }

  function commit() {
    const ids = [...selected];
    start(async () => {
      try {
        const result = await addSpokenToConnections(eventId, ids);
        setPreview(null);
        setSelected(new Set());
        setSummary(result);
        // Truthful headline: "added N" would be a lie when the plan cap bit part-way.
        toast.success(
          result.created + result.matched === 0
            ? "No new connections were added."
            : `${result.created} added, ${result.matched} already in your network.`
        );
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not add those people.");
      }
    });
  }

  function disconnect(attendeeId: string) {
    start(async () => {
      try {
        await removeSpokenToConnection(eventId, attendeeId);
        toast.success("Unlinked from this event. The contact is still in your network.");
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not unlink that person.");
      }
    });
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border/70 px-4 py-10 text-center">
        <p className="text-sm text-muted-foreground">
          No attendees yet. Paste or upload the guest list to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {summary ? <IngestResultCard summary={summary} /> : null}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search this roster"
            className="pl-9"
            aria-label="Search attendees"
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setHideConnected((v) => !v)}
          aria-pressed={hideConnected}
        >
          {hideConnected ? "Show everyone" : "Hide people I know"}
        </Button>
        <Button variant="ghost" size="sm" onClick={toggleAll} disabled={selectable.length === 0}>
          {allSelected ? "Clear selection" : "Select all"}
        </Button>
      </div>

      <ul className="divide-y divide-border/70 rounded-2xl border border-border/70 bg-card">
        {visible.map((row) => {
          const connected = row.contactId !== null;
          return (
            <li key={row.id} className="flex items-center gap-3 px-4 py-3">
              <Checkbox
                checked={selected.has(row.id)}
                onCheckedChange={() => toggle(row.id)}
                disabled={connected || pending}
                aria-label={`I spoke to ${row.fullName ?? row.email ?? "this guest"}`}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">
                  {row.fullName ?? row.email ?? "Unnamed guest"}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {[row.title, row.company].filter(Boolean).join(" · ") ||
                    row.email ||
                    SOURCE_LABEL[row.source]}
                </p>
              </div>
              {connected ? (
                <div className="flex shrink-0 items-center gap-2">
                  <Link
                    href={`/contacts/${row.contactId}`}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                  >
                    <Check className="size-3.5" aria-hidden />
                    In your network
                  </Link>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => disconnect(row.id)}
                    disabled={pending}
                  >
                    Unlink
                  </Button>
                </div>
              ) : (
                <span className="shrink-0 rounded-full border border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground">
                  {SOURCE_LABEL[row.source]}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {visible.length === 0 ? (
        <p className="text-center text-sm text-muted-foreground">No one matches that search.</p>
      ) : null}

      {selected.size > 0 ? (
        <div className="sticky bottom-4 flex items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card p-3 shadow-lg">
          <p className="text-sm text-muted-foreground">
            {selected.size} {selected.size === 1 ? "person" : "people"} selected
          </p>
          <Button onClick={openPreview} disabled={pending}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <UserPlus className="size-4" aria-hidden />
            )}
            Add to connections
          </Button>
        </div>
      ) : null}

      {preview ? (
        <ConnectPreviewDialog
          rows={preview}
          pending={pending}
          onCancel={() => setPreview(null)}
          onConfirm={commit}
        />
      ) : null}
    </div>
  );
}
