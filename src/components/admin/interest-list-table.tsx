"use client";

import { useState } from "react";
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
  followUpSentAtIso: string | null;
  planet: string | null;
};

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
                  Unsubscribe {ids.length}
                </span>
              }
              title={`Stop mailing ${ids.length} ${ids.length === 1 ? "address" : "addresses"}?`}
              description="They stop receiving anything immediately. The rows stay, so you keep their signup dates and sources, and each can be restored individually."
              confirmLabel="Unsubscribe"
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
              description="The rows are erased. Their signup dates and sources are lost, and those addresses can rejoin later as brand-new signups. To simply stop mailing them, use Unsubscribe."
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
            <Th>Email</Th>
            <Th>Signed up</Th>
            <Th>Source</Th>
            <Th>Status</Th>
            <Th>Follow-up</Th>
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
            <Td className="font-medium text-ink">{row.email}</Td>
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
                <span className="text-destructive">Unsubscribed</span>
              ) : row.status === "converted" ? (
                <span className="text-accent-foreground">Converted</span>
              ) : (
                <span className="text-muted-foreground">Active</span>
              )}
            </Td>
            <Td className="text-muted-foreground">
              {row.followUpSentAtIso ? <RelativeTime date={row.followUpSentAtIso} /> : "—"}
            </Td>
            <Td className="capitalize text-muted-foreground">{row.planet ?? "—"}</Td>
            <Td>
              <InterestListRowActions
                id={row.id}
                email={row.email}
                unsubscribed={row.status === "unsubscribed"}
              />
            </Td>
          </tr>
        ))}
      </AdminTable>
    </>
  );
}
