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
 * ## Three states, not two
 *
 * A row is one of: LINKED (connected to a contact from this event), MATCHED (already someone
 * in your network, but not yet attached to this event), or NEW. Before, matched and new were
 * indistinguishable — someone you have known for a year looked exactly like a stranger until
 * you connected them and found out. A matched row is still worth selecting: connecting it is
 * what puts this event on their timeline.
 *
 * Matches arrive with the rows rather than streaming in behind them, because "Hide people I
 * know" filters on them. Streaming would re-sort the list under the user a second after it
 * painted, which is worse than showing the skeleton for that second.
 *
 * Imports only pure modules from `@/lib/events/*` (types) plus the server actions. It must
 * never reach `store.ts` or anything touching `@/db` — `src/lib/surfaces.ts` records that a
 * client component transitively importing the database fails the build with a `node:fs`
 * chunking error naming neither file.
 */
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, Loader2, MoreHorizontal, Pencil, Search, UserPlus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/lib/toast";
import {
  addSpokenToConnections,
  previewConnectAttendees,
  removeSpokenToConnection,
} from "@/actions/events";
import type { ConnectSummary, RosterRow } from "@/lib/events/types";
import { ConnectPreviewDialog, type PreviewRow } from "./connect-preview-dialog";
import { EditAttendeeDialog } from "./edit-attendee-dialog";
import { IngestResultCard } from "./ingest-result-card";
import { friendlyError } from "@/lib/errors";

/** "2nd", "3rd", "4th" — because "2 events together" reads as a count, not a streak. */
function ordinalSuffix(value: number): string {
  if (value % 100 >= 11 && value % 100 <= 13) return "th";
  return ["th", "st", "nd", "rd"][value % 10] ?? "th";
}

/** One roster row already recognised as somebody in your network. */
export type RosterMatch = {
  attendeeId: string;
  contactId: string;
  contactName: string | null;
};

/**
 * Shown only for host and speaker. "Attendee" is the assumed case and badging it would put a
 * label on nearly every row, which is how a badge stops carrying information.
 */
const ROLE_LABEL: Partial<Record<NonNullable<RosterRow["attendeeRole"]>, string>> = {
  host: "Host",
  speaker: "Speaker",
};

const SOURCE_LABEL: Record<RosterRow["source"], string> = {
  paste: "Pasted",
  csv: "CSV",
  screenshot: "Screenshot",
  page: "Event page",
  // Not "the host published this person" but "you were both on the invite" — a weaker claim,
  // and the badge has to make the difference visible.
  calendar: "Calendar invite",
  luma: "Luma",
  eventbrite: "Eventbrite",
};

export function AttendeeRoster({
  eventId,
  rows,
  matches = [],
  history = [],
}: {
  eventId: string;
  rows: RosterRow[];
  matches?: RosterMatch[];
  /** How many events each person has shared with the user, where that is more than one. */
  history?: Array<{ attendeeId: string; eventsTogether: number }>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hideKnown, setHideKnown] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [editing, setEditing] = useState<RosterRow | null>(null);
  const [summary, setSummary] = useState<(ConnectSummary & { remaining: number }) | null>(null);

  const matchById = useMemo(
    () => new Map(matches.map((m) => [m.attendeeId, m])),
    [matches]
  );
  const historyById = useMemo(
    () => new Map(history.map((h) => [h.attendeeId, h.eventsTogether])),
    [history]
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      // "People I know" is both senses of known: linked to this event, and already a contact.
      if (hideKnown && (row.contactId || matchById.has(row.id))) return false;
      if (!needle) return true;
      return [row.fullName, row.email, row.company, row.title, row.linkedinUrl, row.xHandle]
        .filter(Boolean)
        .some((field) => field!.toLowerCase().includes(needle));
    });
  }, [rows, query, hideKnown, matchById]);

  // Already-connected people are excluded from every bulk action: connecting them again is a
  // no-op, so offering it would be a button that claims to do something and does not. A
  // MATCHED row is not excluded — connecting it is what puts this event on their timeline.
  const selectable = visible.filter((row) => !row.contactId);
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.id));

  /**
   * Only ever act on rows the user can currently see.
   *
   * `selected` deliberately outlives filtering, so narrowing the search and widening it again
   * does not silently drop a selection. But acting on the raw set would submit people who are
   * off-screen — and the count beside the button would not match the ticks on screen. Both
   * read from here instead.
   */
  const actionable = useMemo(
    () => visible.filter((row) => !row.contactId && selected.has(row.id)).map((row) => row.id),
    [visible, selected]
  );

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
    if (actionable.length === 0) return;
    // A result card describing the previous run must not sit above the next one.
    setSummary(null);
    start(async () => {
      try {
        setPreview(await previewConnectAttendees(eventId, actionable));
      } catch (error) {
        toast.error(friendlyError(error, "Couldn’t check those people — try again?"));
      }
    });
  }

  function commit() {
    const ids = actionable;
    start(async () => {
      try {
        const result = await addSpokenToConnections(eventId, ids);
        setPreview(null);
        // Keep the selection when the run was cut short by the time budget. The result card
        // tells the user "they stay selected, so you can continue" — clearing here made that
        // sentence false and left them re-picking hundreds of people by hand.
        if (result.remaining > 0) {
          const done = new Set(ids.slice(0, ids.length - result.remaining));
          setSelected((prev) => new Set([...prev].filter((id) => !done.has(id))));
        } else {
          setSelected(new Set());
        }
        setSummary(result);
        // Truthful headline: "added N" would be a lie when the plan cap bit part-way.
        toast.success(
          result.created + result.matched === 0
            ? "No new connections to add"
            : `${result.created} added — ${result.matched} already in your network`
        );
        router.refresh();
      } catch (error) {
        toast.error(friendlyError(error, "Couldn’t add those people — try again?"));
      }
    });
  }

  function disconnect(attendeeId: string) {
    // Tracked per row: one shared flag disabled every other row's controls too, so unlinking
    // one person froze the whole list with no indication of which row was working.
    setBusyRow(attendeeId);
    setSummary(null);
    start(async () => {
      try {
        await removeSpokenToConnection(eventId, attendeeId);
        toast.success("Unlinked from this event — they’re still in your network");
        router.refresh();
      } catch (error) {
        toast.error(friendlyError(error, "Couldn’t unlink that person — try again?"));
      } finally {
        setBusyRow(null);
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
          onClick={() => setHideKnown((v) => !v)}
          aria-pressed={hideKnown}
        >
          {hideKnown ? "Show everyone" : "Hide people I know"}
        </Button>
        <Button variant="ghost" size="sm" onClick={toggleAll} disabled={selectable.length === 0}>
          {allSelected ? "Clear selection" : "Select all"}
        </Button>
      </div>

      <ul className="divide-y divide-border/70 rounded-2xl border border-border/70 bg-card">
        {visible.map((row) => {
          const connected = row.contactId !== null;
          const match = matchById.get(row.id);
          const seenBefore = historyById.get(row.id) ?? 0;
          const busy = busyRow === row.id;
          const who = row.fullName ?? row.email ?? "this guest";
          return (
            <li key={row.id} className="flex items-center gap-3 px-4 py-3">
              <Checkbox
                checked={selected.has(row.id)}
                onCheckedChange={() => toggle(row.id)}
                disabled={connected || busy}
                aria-label={`I spoke to ${who}`}
              />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-sm font-medium text-ink">
                  <span className="truncate">{row.fullName ?? row.email ?? "Unnamed guest"}</span>
                  {row.attendeeRole && ROLE_LABEL[row.attendeeRole] ? (
                    <span className="shrink-0 rounded-full border border-border/70 px-1.5 py-px text-[10px] font-normal text-muted-foreground">
                      {ROLE_LABEL[row.attendeeRole]}
                    </span>
                  ) : null}
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
                  <Button variant="ghost" size="xs" onClick={() => disconnect(row.id)} disabled={busy}>
                    {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                    Unlink
                  </Button>
                </div>
              ) : seenBefore ? (
                // The strongest signal this roster carries: not "who is this" but "you have
                // been in a room with them before and never said so". That belongs in front
                // of the source badge, which is bookkeeping by comparison.
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-ink"
                  title={`You have been at ${seenBefore} events with ${who}`}
                >
                  <Users className="size-3" aria-hidden />
                  {seenBefore}
                  {ordinalSuffix(seenBefore)} event together
                </span>
              ) : match ? (
                // Known, but not yet attached to this event. Still selectable: connecting is
                // what adds this event to the timeline you already have for them.
                <Link
                  href={`/contacts/${match.contactId}`}
                  className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                  title={`${match.contactName ?? "This person"} is already in your contacts`}
                >
                  <Users className="size-3" aria-hidden />
                  Already a contact
                </Link>
              ) : (
                <span className="shrink-0 rounded-full border border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground">
                  {SOURCE_LABEL[row.source]}
                </span>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger
                  type="button"
                  aria-label={`Edit ${who}`}
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <MoreHorizontal className="size-4" aria-hidden />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[9rem]">
                  <DropdownMenuItem onClick={() => setEditing(row)}>
                    <Pencil className="size-4" aria-hidden />
                    Edit details
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          );
        })}
      </ul>

      {visible.length === 0 ? (
        <p className="text-center text-sm text-muted-foreground">No one matches that search.</p>
      ) : null}

      {actionable.length > 0 ? (
        <div className="sticky bottom-4 flex items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card p-3 shadow-lg">
          <p className="text-sm text-muted-foreground">
            {actionable.length} {actionable.length === 1 ? "person" : "people"} selected
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

      {editing ? (
        // Keyed by row, so opening a second person's dialog MOUNTS A NEW ONE. Without this,
        // React reuses the instance and its state comes along: the previous person's typed
        // values, and — the reason this is a bug and not a blemish — an already-armed delete
        // confirmation, so one click could remove someone the user never confirmed.
        <EditAttendeeDialog
          key={editing.id}
          eventId={eventId}
          row={editing}
          onClose={() => setEditing(null)}
        />
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
