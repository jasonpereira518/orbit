import { getSettings } from "@/actions/settings";
import { AiKeyNotice } from "@/components/ai-key-notice";
import { ChatPanelLazy } from "@/components/chat/chat-panel-lazy";

/** Ask/chat server actions call AI providers — allow longer serverless runs. */
export const maxDuration = 60;

export default async function ChatPage() {
  // Production is strictly bring-your-own-key: say so here, before the first question
  // fails, rather than in a toast after it.
  const settings = await getSettings();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <div className="shrink-0">
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
          Chat with your network
        </h1>
        <p className="mt-1 text-muted-foreground">
          Ask who can help, who to follow up with, or who knows what.
        </p>
      </div>
      {!settings.hasApiKey && (
        <div className="shrink-0">
          <AiKeyNotice feature="chat" />
        </div>
      )}
      <ChatPanelLazy />
    </div>
  );
}
