"use client";

import dynamic from "next/dynamic";
import { ChatPanelSkeleton } from "@/components/loading/page-skeletons";
import type { ChatThreadPage } from "@/actions/chat";

const ChatPanel = dynamic(
  () =>
    import("@/components/chat/chat-panel").then((m) => ({
      default: m.ChatPanel,
    })),
  {
    ssr: false,
    // Sized by the page's flex column, matching the real panel. The viewport calc this
    // replaces guessed at the chrome above it, so with the API-key notice showing, the
    // placeholder overflowed exactly like the panel did — and the two disagreed on height,
    // so the card jumped when the chunk landed.
    loading: () => <ChatPanelSkeleton className="min-h-0 w-full flex-1" />,
  }
);

/**
 * Fetch the panel's chunk ahead of a visit (nav hover/focus). The route prefetch does not
 * include it, so a first visit otherwise shows the page skeleton and then this one.
 */
export function preloadChatPanel() {
  void import("@/components/chat/chat-panel").catch(() => {});
}

export function ChatPanelLazy({
  initialThreads = null,
}: {
  /** The history list's first page, read by the page; see `ChatPanel`. */
  initialThreads?: ChatThreadPage | null;
}) {
  return <ChatPanel initialThreads={initialThreads} />;
}
