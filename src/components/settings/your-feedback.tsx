import { FeedbackList } from "@/components/feedback/feedback-list";
import { SettingsRow } from "@/components/settings/settings-section";
import { FEEDBACK_RECIPIENT } from "@/lib/feedback-report";
import { listMyFeedback } from "@/lib/feedback-thread";

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
        {rows.length > 0 && <FeedbackList rows={rows} />}
      </SettingsRow>
    </div>
  );
}
