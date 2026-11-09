"use client";

import { formatDistanceToNow } from "date-fns";
import { Gift } from "lucide-react";
import { FEEDBACK_ANCHOR_FALLBACK, requestFeedbackOpen } from "@/lib/feedback-events";
import { FEEDBACK_RECIPIENT } from "@/lib/feedback-report";
import type { MyFeedbackRow } from "@/lib/feedback-thread";

const STATUS_LABEL: Record<MyFeedbackRow["status"], string> = {
  new: "Sent",
  triaged: `${FEEDBACK_RECIPIENT}'s looking at it`,
  resolved: "Done",
};

/**
 * Someone's own feedback, newest first: what they said, what became of it, and the way back
 * into each conversation. Shared by the feedback panel's "Your feedback" tab and Settings.
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
    <ul className="grid gap-1.5">
      {rows.map((row) => (
        <li key={row.id}>
          <a
            href={`/feedback/${row.id}`}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              open(row.id);
            }}
            className="flex items-start gap-3 rounded-lg border border-border/60 px-3 py-2 text-sm transition-colors hover:border-primary/40"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate">{row.excerpt || "(no text)"}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {formatDistanceToNow(new Date(row.createdAt), { addSuffix: true })} · {STATUS_LABEL[row.status]}
                {row.replies > 0 && ` · ${row.replies} ${row.replies === 1 ? "reply" : "replies"}`}
                {row.thanksCredits != null && ` · +${row.thanksCredits} credits`}
              </span>
            </span>
            {row.giftWaiting ? (
              <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full bg-gold/15 px-2 py-0.5 text-[0.65rem] font-medium text-gold-ink">
                <Gift className="size-3" aria-hidden />
                Gift waiting
              </span>
            ) : (
              row.unread && (
                <span className="mt-0.5 shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[0.65rem] font-medium text-primary">
                  New reply
                </span>
              )
            )}
          </a>
        </li>
      ))}
    </ul>
  );
}
