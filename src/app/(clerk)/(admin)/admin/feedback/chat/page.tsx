import { CheckCircle2, CircleHelp, CircleSlash, MessageSquareText, ThumbsDown, ThumbsUp } from "lucide-react";
import { FeedbackTabs } from "@/components/admin/admin-tabs";
import { Pager } from "@/components/admin/pager";
import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  MetricTile,
  RelativeTime,
  Td,
  Th,
} from "@/components/admin/primitives";
import {
  CHAT_FEEDBACK_PAGE_SIZE,
  getChatFeedbackSummary,
  getChatOutcomeSummary,
  loadChatFeedbackList,
} from "@/lib/admin-chat-feedback";
import { cn } from "@/lib/utils";

export const metadata = { title: "Admin · Chat ratings" };

/**
 * How chat's answers land: the thumbs people gave, and whether chat answered at all.
 *
 * Its own tab rather than a section under the inbox: the inbox is a work queue someone
 * clears, and this is a quality signal someone reads. A static route, so it wins over the
 * sibling `[feedbackId]`.
 */
export default async function AdminChatRatingsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  const requestedPage = Number.parseInt(params.page ?? "1", 10);

  const [chatSummary, chatListing, outcomes] = await Promise.all([
    getChatFeedbackSummary(),
    loadChatFeedbackList({ page: Number.isFinite(requestedPage) ? requestedPage : 1 }),
    getChatOutcomeSummary(),
  ]);
  const share = (n: number) =>
    outcomes.labelled > 0 ? `${Math.round((n / outcomes.labelled) * 100)}%` : "—";

  return (
    <>
      <AdminPageHeader title="Feedback" subtitle="How chat's answers land with the people who asked." />
      <FeedbackTabs />

      <div>
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <MetricTile label="Thumbs up" value={chatSummary.up} icon={ThumbsUp} tone="muted" />
          <MetricTile label="Thumbs down" value={chatSummary.down} icon={ThumbsDown} tone="muted" />
          <MetricTile label="Last 7 days" value={chatSummary.last7Days} icon={MessageSquareText} />
        </div>

        {/* Every answer, rated or not — labelled when it was stored (`@/lib/chat-abstention`). */}
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">
          Did chat answer? Last 7 days
        </h2>
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <MetricTile
            label="Answered"
            value={share(outcomes.answered)}
            hint={`${outcomes.answered} of ${outcomes.labelled} answers`}
            icon={CheckCircle2}
          />
          <MetricTile
            label="Partly"
            value={share(outcomes.partial)}
            hint={`${outcomes.partial} said what the records did not show`}
            icon={CircleHelp}
            tone="muted"
          />
          <MetricTile
            label="Didn't know"
            value={share(outcomes.abstained)}
            hint={`${outcomes.abstained} found nothing to go on`}
            icon={CircleSlash}
            tone={outcomes.labelled > 0 && outcomes.abstained / outcomes.labelled > 0.2 ? "danger" : "muted"}
          />
        </div>

        {/*
          No question or answer text here, on purpose — `chat_messages.content` is on the
          permanent denylist in `admin-redaction.ts`. Just the rating itself: who, when, up
          or down, and the optional note a thumbs-down can carry, which is text someone
          meant as feedback rather than a transcript.
        */}
        <AdminPanel>
          {chatListing.rows.length === 0 ? (
            <EmptyState>No chat answers have been rated yet.</EmptyState>
          ) : (
            <>
              <AdminTable
                label="Rated chat answers"
                head={
                  <>
                    <Th>When</Th>
                    <Th>Who</Th>
                    <Th>Rating</Th>
                    <Th>Note</Th>
                  </>
                }
              >
                {chatListing.rows.map((row) => (
                  <tr key={row.id} className="border-b border-border/40 last:border-0">
                    <Td className="whitespace-nowrap text-muted-foreground">
                      <RelativeTime date={row.createdAt} />
                    </Td>
                    <Td className="text-muted-foreground">
                      {row.submitterEmail ?? (
                        <span className="text-muted-foreground/50">account purged</span>
                      )}
                    </Td>
                    <Td>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.625rem] font-medium",
                          row.feedback === "up"
                            ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                            : "bg-destructive/15 text-destructive"
                        )}
                      >
                        {row.feedback === "up" ? (
                          <ThumbsUp className="size-3 fill-current" />
                        ) : (
                          <ThumbsDown className="size-3 fill-current" />
                        )}
                        {row.feedback}
                      </span>
                    </Td>
                    <Td className="text-muted-foreground">
                      {row.feedbackNote?.trim() || <span className="text-muted-foreground/50">—</span>}
                    </Td>
                  </tr>
                ))}
              </AdminTable>
              <Pager
                page={chatListing.page}
                pageCount={chatListing.pageCount}
                total={chatListing.total}
                pageSize={CHAT_FEEDBACK_PAGE_SIZE}
                hrefFor={(page) => `/admin/feedback/chat${page > 1 ? `?page=${page}` : ""}`}
                label="ratings"
              />
            </>
          )}
        </AdminPanel>
      </div>
    </>
  );
}
