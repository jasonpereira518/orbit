"use client";

import Link from "next/link";
import { BuyPackButton } from "@/components/credits/buy-pack-button";
import { integrationHref } from "@/components/settings/sections";
import { useViewerPlan } from "@/components/viewer-plan";
import { AI_NOTICE_COPY } from "@/lib/ai-access-copy";
import type { AiAccessDenial } from "@/lib/managed-ai-policy";

/**
 * The one message for "AI can't run for you right now". Pages render it from what they
 * already loaded (`reason`); the only thing it reads for itself is the viewer's plan, so it
 * pitches the right way out.
 *
 *  - No key on Free: add a key — or Pro and Max, which include AI.
 *  - Out of credits on Pro or Max: buy a $5 pack, or (Pro) upgrade to Max, or use a key.
 *    Nothing is charged automatically; this is where the person chooses.
 *  - Orbit's AI briefly unavailable: it comes back; a key keeps you going meanwhile.
 *
 * `compact` drops the explanation below `sm`, leaving the headline and the actions. On /chat
 * the notice shares a viewport-bounded page with the chat card, and at full length on a
 * phone it took ~130px from the message area.
 */
export function AiKeyNotice({
  feature,
  reason,
  compact = false,
}: {
  feature: "capture" | "chat" | "setup" | "meeting" | "knowledge";
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
          : feature === "knowledge"
            ? "summarize people and see how they fit your goals"
            : "read your notes and answer questions";
  const { plan, includedAiAvailable } = useViewerPlan();
  const copy = AI_NOTICE_COPY[reason ?? "key_required"];
  // "Pro and Max include AI" only to a Free account, and only where it can actually run.
  const offerUpgrade = copy.offer === "upgrade" && plan === "free" && includedAiAvailable;
  const offerCredits = copy.offer === "credits" && (plan === "orbit" || plan === "max");
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
            {offerCredits ? "Or use your own key under " : copy.offer === "upgrade" ? "Add one under " : "Keys live under "}
            <Link href={integrationHref("ai")} className={link}>
              Settings → Integrations → AI provider
            </Link>
            {offerUpgrade ? (
              <span className={extra}>
                , or move to{" "}
                <Link href="/pricing" className={link}>
                  Orbit Pro or Max
                </Link>
                , which include AI
              </span>
            ) : null}
            .
          </>
        )}
      </p>
      {offerCredits && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <BuyPackButton />
          {plan === "orbit" && (
            <Link
              href="/settings#settings-plan"
              data-plan="max"
              className="inline-flex h-7 items-center rounded-md border border-tier-border bg-tier-surface px-2.5 text-xs font-medium text-tier-accent hover:bg-tier-accent/15"
            >
              Upgrade to Max
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
