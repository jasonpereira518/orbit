"use client";

import { Check, Gift } from "lucide-react";
import { FEEDBACK_ANCHOR_FALLBACK, requestFeedbackOpen } from "@/lib/feedback-events";
import { FEEDBACK_RECIPIENT } from "@/lib/feedback-report";
import type { MyFeedbackRow } from "@/lib/feedback-thread";
import { cn } from "@/lib/utils";

/** "2m", "3h", "Tue", "Nov 4" — a messages app's time column. */
function shortTime(at: Date): string {
  const ms = Date.now() - at.getTime();
  if (ms < 60_000) return "now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  if (ms < 7 * 86_400_000) return at.toLocaleDateString(undefined, { weekday: "short" });
  return at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Someone's conversations with the operator, newest activity first, the way a messages app
 * lists them: an unread dot (or the gift, while a thank-you is still wrapped), the subject,
 * a short time, and the latest message with who sent it. Finished ones carry a "Fixed" tick;
 * ones nobody has opened yet say so. Shared by the feedback panel and Settings.
 *
 * A row opens its conversation in the feedback side panel (`onOpen`, or by default the
 * panel's open request). It is still a real link to `/feedback/[id]`, so a middle-click or a
 * new tab gets the page.
 */
export function FeedbackList({
  rows,
  onOpen,
}: {
  rows: MyFeedbackRow[];
  onOpen?: (id: string) => void;
}) {
  const open = onOpen ?? ((id: string) => requestFeedbackOpen(FEEDBACK_ANCHOR_FALLBACK, { view: "thread", id }));

  return (
    <ul className="divide-y divide-border/60">
      {rows.map((row) => {
        const fresh = row.unread || row.giftWaiting;
        const who = row.last.author === "operator" ? FEEDBACK_RECIPIENT : "You";
        const status = row.giftWaiting ? (
          <span className="text-gold-ink">Thank-you waiting to open</span>
        ) : row.status === "resolved" ? (
          <span className="inline-flex items-center gap-1 text-primary">
            <Check className="size-3" aria-hidden />
            Fixed
          </span>
        ) : row.replies === 0 && !row.operatorRead ? (
          <span>Sent · {FEEDBACK_RECIPIENT} hasn&apos;t read it yet</span>
        ) : null;
        return (
          <li key={row.id}>
            <a
              href={`/feedback/${row.id}`}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                open(row.id);
              }}
              className="flex gap-2.5 px-5 py-3 text-sm transition-colors hover:bg-muted/50"
            >
              <span className="mt-1.5 flex w-3.5 shrink-0 justify-center" aria-hidden>
                {row.giftWaiting ? (
                  <Gift className="-mt-0.5 size-3.5 text-gold-ink" />
                ) : row.unread ? (
                  <span className="size-2 rounded-full bg-primary" />
                ) : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className={cn("truncate", fresh ? "font-semibold text-foreground" : "font-medium")}>
                    {row.subject || row.excerpt || "(no subject)"}
                  </span>
                  <span className="shrink-0 text-[0.7rem] text-muted-foreground">{shortTime(new Date(row.last.at))}</span>
                </span>
                <span className={cn("block truncate", fresh ? "text-foreground" : "text-muted-foreground")}>
                  {who}: {row.last.body || "(no text)"}
                </span>
                {status && <span className="mt-0.5 block text-xs text-muted-foreground">{status}</span>}
                {fresh && <span className="sr-only">{row.giftWaiting ? "Gift waiting" : "New reply"}</span>}
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
