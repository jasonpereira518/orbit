"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

const ChatPanel = dynamic(
  () =>
    import("@/components/chat/chat-panel").then((m) => ({
      default: m.ChatPanel,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        <Skeleton className="min-h-[min(70vh,640px)] w-full rounded-2xl" />
        <Skeleton className="hidden min-h-[min(70vh,640px)] w-full rounded-2xl lg:block" />
      </div>
    ),
  }
);

export function ChatPanelLazy() {
  return <ChatPanel />;
}
