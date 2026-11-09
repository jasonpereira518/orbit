import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { SettingsRow } from "@/components/settings/settings-section";
import { FEEDBACK_RECIPIENT } from "@/lib/feedback-report";
import { listMyFeedback } from "@/lib/feedback-thread";

const STATUS_LABEL = {
  new: "Sent",
  triaged: `${FEEDBACK_RECIPIENT}'s looking at it`,
  resolved: "Done",
} as const;

/**
 * Everything you've sent through the feedback button, what became of it, and the way back
 * into each conversation. Seeing "Done" next to something you reported is half the reason to
 * report the next thing.
 */
export async function YourFeedback({ userId }: { userId: string }) {
  const rows = await listMyFeedback(userId);

  return (
    <div id="your-feedback" className="scroll-mt-24">
      <SettingsRow
        title="Your feedback"
        description={
          rows.length === 0
            ? `Nothing yet. Anything you send ${FEEDBACK_RECIPIENT} shows up here, with his replies.`
            : `What you've sent ${FEEDBACK_RECIPIENT}, and his replies.`
        }
      >
        {rows.length > 0 && (
          <ul className="grid gap-1.5">
            {rows.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/feedback/${row.id}`}
                  className="flex items-start gap-3 rounded-lg border border-border/60 px-3 py-2 text-sm transition-colors hover:border-primary/40"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{row.excerpt || "(no text)"}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {formatDistanceToNow(row.createdAt, { addSuffix: true })} · {STATUS_LABEL[row.status]}
                      {row.replies > 0 && ` · ${row.replies} ${row.replies === 1 ? "reply" : "replies"}`}
                      {row.thanksCredits != null && ` · +${row.thanksCredits} credits`}
                    </span>
                  </span>
                  {row.unread && (
                    <span className="mt-0.5 shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[0.65rem] font-medium text-primary">
                      New reply
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </SettingsRow>
    </div>
  );
}
