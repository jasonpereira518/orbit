import { ChatPanelLazy } from "@/components/chat/chat-panel-lazy";

/** Ask/chat server actions call AI providers — allow longer serverless runs. */
export const maxDuration = 60;

export default function ChatPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden sm:gap-4">
      <div className="shrink-0">
        <h1 className="font-[family-name:var(--font-display)] text-2xl text-primary sm:text-3xl">
          Chat
          <span className="hidden sm:inline"> with your network</span>
        </h1>
        <p className="mt-0.5 hidden text-muted-foreground sm:mt-1 sm:block">
          Ask who can help, who to follow up with, or who knows what.
        </p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ChatPanelLazy />
      </div>
    </div>
  );
}
