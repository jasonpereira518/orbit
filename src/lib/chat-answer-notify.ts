import { showDesktopNotification } from "@/lib/browser-notifications";
import { bumpTitleBadge } from "@/lib/tab-title-badge";

/**
 * An answer landed while the person was on another tab: badge this tab's title and, if they
 * have desktop notifications on, show one. A visible tab needs neither, the answer is on
 * screen. Both helpers are no-ops outside the browser and swallow their own failures.
 */
export function notifyAnswerLanded(input: { threadId: string | null; messageId: string | null; title: string | null }) {
  if (typeof document === "undefined" || !document.hidden) return;
  bumpTitleBadge(1);
  void showDesktopNotification({
    // Keyed by the saved answer, so a resumed turn that lands twice notifies once.
    id: `chat-answer:${input.messageId || input.threadId || Date.now()}`,
    kind: "chat",
    title: "Your answer is ready",
    body: input.title?.trim() || undefined,
    url: input.threadId ? `/chat?thread=${input.threadId}` : "/chat",
  });
}
