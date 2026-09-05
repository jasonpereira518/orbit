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
      <ChatPanelSkeleton className="h-[calc(100dvh-16.5rem)] w-full md:h-[calc(100dvh-11rem)]" />
    ),
  }
);

export function ChatPanelLazy() {
  return <ChatPanel />;
}
