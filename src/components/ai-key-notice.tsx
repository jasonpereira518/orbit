import Link from "next/link";

/**
 * The one message for "you cannot use this yet": production is strictly bring-your-own-key,
 * so a new account hits a hard error on its first capture or question until a provider key
 * is saved. Server-safe (no hooks), so pages can render it from what they already loaded.
 */
export function AiKeyNotice({ feature }: { feature: "capture" | "chat" | "setup" }) {
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
        Orbit runs AI on your own Gemini, OpenAI, or Anthropic key, at cost and never marked
        up. Add one under{" "}
        <Link
          href="/settings#settings-ai"
          className="font-medium text-primary underline-offset-2 hover:underline"
        >
          Settings → AI provider
        </Link>
        {" "}and everything else here works without it.
      </p>
    </div>
  );
}
