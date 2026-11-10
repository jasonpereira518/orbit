import Link from "next/link";
import { notFound } from "next/navigation";
import { FeedbackChat, threadMeta } from "@/components/feedback/feedback-chat";
import { RenderStamp } from "@/components/layout/render-stamp";
import { requireUserId } from "@/lib/auth";
import { FEEDBACK_RECIPIENT } from "@/lib/feedback-report";
import { loadThread, markThreadRead } from "@/lib/feedback-thread";

export const metadata = { title: "Your feedback" };

/**
 * One feedback report and its conversation with the operator — where the bell's "replied"
 * item and the reply email both land. Someone else's report is a 404, never a "not yours".
 */
export default async function FeedbackThreadPage({
  params,
}: {
  params: Promise<{ feedbackId: string }>;
}) {
  const { feedbackId } = await params;
  const userId = await requireUserId();
  const thread = await loadThread(feedbackId, { userId });
  if (!thread) notFound();
  if (thread.open) await markThreadRead(feedbackId, "user", userId);

  return (
    <div className="mx-auto flex h-[calc(100dvh-6rem)] w-full max-w-2xl flex-col px-4 py-6">
      <RenderStamp />
      <div className="grid shrink-0 gap-1 pb-4">
        <Link
          href="/settings#your-feedback"
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          ← All your feedback
        </Link>
        <h1 className="font-[family-name:var(--font-display)] text-2xl text-ink">
          {thread.report.subject || `Your conversation with ${FEEDBACK_RECIPIENT}`}
        </h1>
        <p className="text-xs text-muted-foreground">{threadMeta(thread)}</p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/60 bg-card">
        <FeedbackChat initial={thread} />
      </div>
    </div>
  );
}
