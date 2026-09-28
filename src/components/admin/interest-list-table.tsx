"use client";

import { useEffect, useState } from "react";
import { MailX, Trash2 } from "lucide-react";
import { AdminTable, RelativeTime, Td, Th } from "@/components/admin/primitives";
import { ConfirmActionDialog } from "@/components/admin/confirm-action-dialog";
import { InterestListRowActions } from "@/components/admin/interest-list-actions";
import {
  bulkDeleteInterestListAction,
  bulkUnsubscribeInterestListAction,
} from "@/actions/admin";
import { cn } from "@/lib/utils";

/**
 * The roster table, client-side only because selection is client state.
 *
 * Rows arrive already shaped and already filtered by the server; this adds checkboxes and
 * the bulk bar on top. Dates are passed as ISO strings rather than `Date` objects — the
 * server/client boundary serialises them either way, and being explicit about it stops the
 * absolute label from silently depending on how Next happened to revive the value.
 */

export type InterestListTableRow = {
  id: string;
  email: string;
  createdAtIso: string;
  createdAtLabel: string;
  source: string;
  status: "active" | "converted" | "unsubscribed";
  /** Place in line; null once they have left. */
  position: number | null;
  /** Place by join order alone; null once they have left. */
  joinRank: number | null;
  referrals: number;
  /** Label of the referral tier they hold, once they hold one (0 referrals holds none). */
  tierLabel: string | null;
  planet: string | null;
  /** Times they opened their own pass. */
  passCheckCount: number;
  /** ISO of the most recent pass open, or null if never. */
  passLastCheckedAtIso: string | null;
};

/** Spots gained on join order: `+25` moved up, `−3` passed by others, `—` where nothing moved. */
function MovedCell({ position, joinRank }: { position: number | null; joinRank: number | null }) {
  if (position === null || joinRank === null || position === joinRank) {
    return <span className="text-muted-foreground/50">—</span>;
  }
  const moved = joinRank - position;
  return moved > 0 ? (
    <span className="text-accent-foreground">+{moved.toLocaleString("en-US")}</span>
  ) : (
    <span className="text-muted-foreground">−{Math.abs(moved).toLocaleString("en-US")}</span>
  );
}

/**
 * Check count with "how long ago was the last one" in the hover title.
 *
 * The title is relative and client-driven for the same purity/hydration reason as
 * `RelativeTime`: a relative label is a function of "now".
 */
function PassChecksCell({
  count,
  lastCheckedAtIso,
}: {
  count: number;
  lastCheckedAtIso: string | null;
}) {
  const [ago, setAgo] = useState<string | null>(null);

  useEffect(() => {
    if (!lastCheckedAtIso) {
      setAgo(null);
      return;
    }
    const update = () => setAgo(relativeAgoLabel(new Date(lastCheckedAtIso)));
    update();
    const timer = setInterval(update, 60_000);
    return () => clearInterval(timer);
  }, [lastCheckedAtIso]);

  const title = !lastCheckedAtIso
    ? "Never checked their pass"
    : ago
      ? `Last checked ${ago}`
      : undefined;

  return (
    <span
      className={cn("tabular-nums", count === 0 && "text-muted-foreground/50")}
      title={title}
    >
      {count.toLocaleString("en-US")}
    </span>
  );
}

/** Same compact relative labels as `RelativeTime`, with an "ago" suffix for title copy. */
function relativeAgoLabel(d: Date): string {
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60_000);
  if (Math.abs(mins) < 1) return "just now";
  if (Math.abs(mins) < 60) return `${mins}m ago`;
  const hours = Math.round(diff / 3_600_000);
  if (Math.abs(hours) < 24) return `${hours}h ago`;
  const days = Math.round(diff / 86_400_000);
  if (Math.abs(days) < 365) return `${days}d ago`;
  return `${Math.round(days / 365)}y ago`;
}

const BULK_BUTTON =
  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors duration-fast";

export function InterestListTable({ rows }: { rows: InterestListTableRow[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const ids = [...selected];
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected((prev) => {
      if (rows.every((r) => prev.has(r.id))) {
        const next = new Set(prev);
        for (const r of rows) next.delete(r.id);
        return next;
      }
      return new Set([...prev, ...rows.map((r) => r.id)]);
    });

  return (
    <>
      {/* Reserves its own height rather than appearing on selection: a bar that pops in
          shifts the first row down exactly as someone is clicking the second checkbox. */}
      <div className="mb-3 flex min-h-8 items-center gap-2">
        {ids.length > 0 ? (
          <>
            <span className="text-xs tabular-nums text-muted-foreground">
              {ids.length} selected
            </span>
            <ConfirmActionDialog
              trigger={
                <span
                  className={cn(
                    BULK_BUTTON,
                    "border-border/70 text-muted-foreground hover:text-foreground"
                  )}
                >
                  <MailX className="size-3" aria-hidden />
                  Remove {ids.length}
                </span>
              }
              title={`Take ${ids.length} ${ids.length === 1 ? "address" : "addresses"} off the waitlist?`}
              description="They leave the line and stop receiving anything immediately. The rows stay, so you keep their signup dates and sources, and each can be restored to its old place."
              confirmLabel="Remove from line"
              onConfirm={async (reason) => {
                await bulkUnsubscribeInterestListAction({ ids, reason });
                setSelected(new Set());
              }}
            />
            <ConfirmActionDialog
              trigger={
                <span
                  className={cn(
                    BULK_BUTTON,
                    "border-destructive/40 text-destructive hover:bg-destructive/10"
                  )}
                >
                  <Trash2 className="size-3" aria-hidden />
                  Delete {ids.length}
                </span>
              }
              title={`Delete ${ids.length} ${ids.length === 1 ? "signup" : "signups"} entirely?`}
              description="The rows are erased. Their signup dates and sources are lost, and those addresses can rejoin later as brand-new signups. To take them out of line but keep the record, use Remove."
              confirmLabel="Delete permanently"
              danger
              typedConfirmation={String(ids.length)}
              typedConfirmationHint={`Type ${ids.length} to confirm`}
              onConfirm={async (reason) => {
                await bulkDeleteInterestListAction({ ids, reason });
                setSelected(new Set());
              }}
            />
          </>
        ) : (
          <span className="text-xs text-muted-foreground/60">
            Select rows for bulk actions.
          </span>
        )}
      </div>

      <AdminTable
        head={
          <>
            <Th className="w-8">
              <input
                type="checkbox"
                checked={allOnPage}
                onChange={toggleAll}
                aria-label="Select all on this page"
                className="size-3.5 accent-current"
              />
            </Th>
            <Th numeric>In line</Th>
            <Th numeric>Joined #</Th>
            <Th numeric>Moved</Th>
            <Th>Email</Th>
            <Th numeric>Referrals</Th>
            <Th numeric>Checks</Th>
            <Th>Signed up</Th>
            <Th>Source</Th>
            <Th>Status</Th>
            <Th>Planet</Th>
            <Th className="text-right">Actions</Th>
          </>
        }
      >
        {rows.map((row) => (
          <tr
            key={row.id}
            className={cn(
              "border-b border-border/40 last:border-0 hover:bg-muted/30",
              selected.has(row.id) && "bg-accent/[0.06]"
            )}
          >
            <Td>
              <input
                type="checkbox"
                checked={selected.has(row.id)}
                onChange={() => toggle(row.id)}
                aria-label={`Select ${row.email}`}
                className="size-3.5 accent-current"
              />
            </Td>
            <Td numeric className="tabular-nums">
              {row.position !== null ? `#${row.position.toLocaleString("en-US")}` : "—"}
            </Td>
            <Td numeric className="tabular-nums text-muted-foreground">
              {row.joinRank !== null ? `#${row.joinRank.toLocaleString("en-US")}` : "—"}
            </Td>
            <Td numeric className="tabular-nums">
              <MovedCell position={row.position} joinRank={row.joinRank} />
            </Td>
            <Td className="font-medium text-ink">{row.email}</Td>
            <Td numeric className={row.referrals === 0 ? "text-muted-foreground/50" : undefined}>
              {row.referrals}
            </Td>
            <Td numeric>
              <PassChecksCell
                count={row.passCheckCount}
                lastCheckedAtIso={row.passLastCheckedAtIso}
              />
            </Td>
            <Td>
              {/* Absolute first — "when did they join" is the question, and a relative
                  label alone stops being an answer after a month. */}
              <span className="tabular-nums">{row.createdAtLabel}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                <RelativeTime date={row.createdAtIso} /> ago
              </span>
            </Td>
            <Td className="text-muted-foreground">{row.source}</Td>
            <Td>
              {row.status === "unsubscribed" ? (
                <span className="text-destructive">Left</span>
              ) : row.status === "converted" ? (
                <span className="text-accent-foreground">Converted</span>
              ) : row.tierLabel ? (
                <span className="font-medium text-accent-foreground">{row.tierLabel}</span>
              ) : (
                <span className="text-muted-foreground">Waiting</span>
              )}
            </Td>
            <Td className="capitalize text-muted-foreground">{row.planet ?? "—"}</Td>
            <Td>
              <InterestListRowActions
                id={row.id}
                email={row.email}
                unsubscribed={row.status === "unsubscribed"}
                invitable={row.status === "active"}
              />
            </Td>
          </tr>
        ))}
      </AdminTable>
    </>
  );
}
