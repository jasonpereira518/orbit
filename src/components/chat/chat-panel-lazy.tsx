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
      <div className="flex h-[calc(100dvh-16.5rem)] w-full flex-col overflow-hidden rounded-2xl border border-border/70 md:h-[calc(100dvh-11rem)]">
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-3">
          <Skeleton className="h-8 w-20" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-20" />
        </div>
        <div className="min-h-0 flex-1 basis-0 overflow-hidden p-4">
          <div className="mx-auto w-full max-w-3xl space-y-4">
            <div className="flex justify-end">
              <Skeleton className="h-12 w-2/3 rounded-2xl" />
            </div>
            <div className="flex justify-start">
              <Skeleton className="h-24 w-4/5 rounded-2xl" />
            </div>
          </div>
        </div>
        <div className="shrink-0 space-y-2 border-t border-border/60 p-4">
          <div className="mx-auto max-w-3xl space-y-2.5">
            <Skeleton className="h-14 w-full rounded-lg" />
            <div className="flex flex-wrap gap-1.5">
              <Skeleton className="h-6 w-28 rounded-full" />
              <Skeleton className="h-6 w-36 rounded-full" />
              <Skeleton className="h-6 w-32 rounded-full" />
            </div>
          </div>
        </div>
      </div>
    ),
  }
);

export function ChatPanelLazy() {
  return <ChatPanel />;
}
