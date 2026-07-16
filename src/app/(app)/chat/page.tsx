import { ChatPanel } from "@/components/chat/chat-panel";

export default function ChatPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-[#0f3d3e]">
          Chat with your network
        </h1>
        <p className="mt-1 text-muted-foreground">
          Ask who can help — answers cite real contacts only, never invented people.
        </p>
      </div>
      <ChatPanel />
    </div>
  );
}
