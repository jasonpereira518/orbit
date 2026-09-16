import Link from "next/link";
import { integrationHref } from "@/components/settings/sections";

/**
 * The one message for "you cannot use this yet": production is strictly bring-your-own-key,
 * so a new account hits a hard error on its first capture or question until a provider key
 * is saved. Server-safe (no hooks), so pages can render it from what they already loaded.
 *
 * `compact` drops the pricing explanation below `sm`, leaving the headline and the link.
 * On /chat the notice shares a viewport-bounded page with the chat card, and at full length
 * on a phone it took ~130px from the message area.
 */
export function AiKeyNotice({
  feature,
  compact = false,
}: {
  feature: "capture" | "chat" | "setup";
  compact?: boolean;
}) {
  const extra = compact ? "hidden sm:inline" : undefined;
  const verb =
    feature === "chat"
      ? "answer questions about your network"
      : feature === "capture"
        ? "extract people from notes"
        : "read your notes and answer questions";
  return (
    <div className="rounded-xl border border-amber-200/80 bg-amber-50/70 px-4 py-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/30">
      <p className="font-medium text-foreground">Add an AI API key to {verb}</p>
      <p className="mt-1 text-muted-foreground">
        <span className={extra}>
          Orbit runs AI on your own Gemini, OpenAI, or Anthropic key, at cost and never
          marked up.{" "}
        </span>
        Add one under{" "}
        <Link
          href={integrationHref("ai")}
          className="font-medium text-primary underline-offset-2 hover:underline"
        >
          Settings → Integrations → AI provider
        </Link>
        <span className={extra}> and everything else here works without it</span>.
      </p>
    </div>
  );
}
