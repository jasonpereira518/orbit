import { ChatPanelLazy } from "@/components/chat/chat-panel-lazy";
import { getSettings } from "@/actions/settings";
import { requireUserId } from "@/lib/auth";
import { hasAnyContacts } from "@/lib/onboarding";

/** Ask/chat server actions call AI providers — allow longer serverless runs. */
export const maxDuration = 60;

export default async function ChatPage() {
  const [settings, hasContacts] = await Promise.all([
    getSettings(),
    // Request-cached — costs nothing on top of the layout's own check.
    requireUserId().then(hasAnyContacts),
  ]);

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
      <ChatPanelLazy hasApiKey={settings.hasApiKey} hasContacts={hasContacts} />
    </div>
  );
}
