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
    loading: () => (
      <ChatPanelSkeleton className="min-h-0 w-full flex-1 md:h-[calc(100dvh-11rem)] md:flex-none" />
    ),
  }
);

export function ChatPanelLazy() {
  return <ChatPanel />;
}
