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
    // Phones bound the whole page — heading, the no-key notice, and the chat card — and
    // the card takes what is left. The card used to carry its own fixed height, which
    // assumed only the heading sat above it: with the notice showing, the card was
    // pushed down past the nav and its input sat under the raised Capture button. The
    // offset stops the page just above that button (measured: page top 89px, button
    // top 735px at 375x812). The flex chain can't do this unaided, because the route
    // template's wrapper breaks it — hence a height here rather than `flex-1`.
    <div className="flex h-[calc(100dvh-11rem-env(safe-area-inset-bottom))] min-h-0 flex-col gap-4 overflow-hidden md:h-auto md:flex-1">
      <div className="shrink-0">
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
          Chat with your network
        </h1>
        {/* Hidden on phones: the empty chat card says the same thing, and every line here
            comes out of the message area. */}
        <p className="mt-1 hidden text-muted-foreground sm:block">
          Ask who can help, who to follow up with, or who knows what.
        </p>
      </div>
      {!settings.hasApiKey && (
        <div className="shrink-0">
          <AiKeyNotice feature="chat" compact />
        </div>
      )}
      <ChatPanelLazy />
    </div>
  );
}
