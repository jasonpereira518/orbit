"use client";

import dynamic from "next/dynamic";
import { ChatPanelSkeleton } from "@/components/loading/page-skeletons";

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

export function ChatPanelLazy() {
  return <ChatPanel />;
}
