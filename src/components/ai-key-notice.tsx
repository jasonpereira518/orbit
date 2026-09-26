"use client";

import Link from "next/link";
import { useLifetimeIncludesAi } from "@/components/lifetime-ai-offer";
import { integrationHref } from "@/components/settings/sections";
import { AI_NOTICE_COPY } from "@/lib/ai-access-copy";
import type { AiAccessDenial } from "@/lib/managed-ai-policy";

/**
 * The one message for "AI can't run for you right now". Pages render it from what they
 * already loaded (`reason`); the only thing it reads for itself is whether this deployment
 * can honour the Lifetime pitch (`useLifetimeIncludesAi`).
 *
 * WHICH message depends on the account, and that is the point of `reason` — the AI gate's
 * own verdict (`getSettings().ai.reason`, or `aiDenialFromMessage` on a refusal a client just
 * received). Without a key and not on Lifetime: add a key, or get Lifetime. On Lifetime with
 * the month's allowance spent: add your own key to keep going. Mid-upgrade: nothing to do,
 * it is on its way. Omitted, it reads as the plain "add a key" case.
 *
 * `compact` drops the explanation below `sm`, leaving the headline and the link. On /chat
 * the notice shares a viewport-bounded page with the chat card, and at full length on a
 * phone it took ~130px from the message area.
 */
export function AiKeyNotice({
  feature,
  reason,
  compact = false,
}: {
  feature: "capture" | "chat" | "setup" | "meeting";
  reason?: AiAccessDenial | null;
  compact?: boolean;
}) {
  const extra = compact ? "hidden sm:inline" : undefined;
  const verb =
    feature === "chat"
      ? "answer questions about your network"
      : feature === "capture"
        ? "extract people from notes"
        : feature === "meeting"
          ? "summarize meetings"
          : "read your notes and answer questions";
  const lifetimeIncludesAi = useLifetimeIncludesAi();
  const copy = AI_NOTICE_COPY[reason ?? "key_required"];
  // Only pitch Lifetime for its AI where Lifetime actually comes with it.
  const offerLifetime = copy.offerLifetime && lifetimeIncludesAi;
  const link = "font-medium text-primary underline-offset-2 hover:underline";
  return (
    <div
      role="status"
      className="rounded-xl border border-warning-border bg-warning-surface px-4 py-3 text-sm"
    >
      <p className="font-medium text-foreground">{copy.title(verb)}</p>
      <p className="mt-1 text-muted-foreground">
        <span className={extra}>{copy.body} </span>
        {copy.linkToKeys && (
          <>
            {copy.offerLifetime ? "Add one under " : "Keys live under "}
            <Link href={integrationHref("ai")} className={link}>
              Settings → Integrations → AI provider
            </Link>
            {offerLifetime ? (
              <span className={extra}>
                , or get{" "}
                <Link href="/pricing" className={link}>
                  Orbit Lifetime
                </Link>
                , which includes AI
              </span>
            ) : null}
            .
          </>
        )}
      </p>
    </div>
  );
}
