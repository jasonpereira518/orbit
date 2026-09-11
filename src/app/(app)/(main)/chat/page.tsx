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
    /**
     * Height lives here, not on the panel.
     *
     * `(app)/template.tsx` wraps every route in a bare `<div>` for the view transition,
     * which is display:block — so the shell's bounded flex column stops there and neither
     * `flex-1` nor `h-full` reaches a page. That break is why this surface (and /graph)
     * size themselves off the viewport at all.
     *
     * Pinning the height on THIS container rather than the card is what fixes the
     * API-key notice: the notice is a sibling in this flex column, so it takes its share
     * and the card absorbs the rest, instead of the card assuming a fixed amount of
     * chrome above it and running off the bottom of the screen.
     *
     * Below `md` the offset also clears the floating nav, not just the shell's padding and
     * header: the raised Capture button overlaps the page bottom, and a smaller offset put
     * the composer under it. Measured at 375x812: page top 89px, Capture top 735px. The
     * safe-area term matters in standalone mode, where the nav rides above the home bar.
     */
    <div className="flex h-[calc(100dvh-11rem-env(safe-area-inset-bottom))] min-h-0 flex-col gap-4 overflow-hidden md:h-[calc(100dvh-4rem)]">
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
