import { ChatPanelLazy } from "@/components/chat/chat-panel-lazy";

export default function ChatPage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">
          Chat with your network
        </h1>
        <p className="mt-1 text-muted-foreground">
          Ask who can help — or update contacts from notes on the side.
        </p>
      </div>
      <ChatPanelLazy />
    </div>
  );
}
