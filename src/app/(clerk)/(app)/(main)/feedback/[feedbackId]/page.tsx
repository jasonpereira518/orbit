import Link from "next/link";
import { notFound } from "next/navigation";
import { FeedbackChat } from "@/components/feedback/feedback-chat";
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
    <div className="mx-auto grid w-full max-w-2xl gap-6 px-4 py-8">
      <div className="grid gap-1">
        <Link
          href="/settings#your-feedback"
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          ← All your feedback
        </Link>
        <h1 className="font-[family-name:var(--font-display)] text-2xl text-ink">
          {thread.open ? `Your conversation with ${FEEDBACK_RECIPIENT}` : "Your feedback"}
        </h1>
      </div>
      <FeedbackChat initial={thread} />
    </div>
  );
}
