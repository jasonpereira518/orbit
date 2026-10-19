"use client";

import Link from "next/link";
import { BuyPackButton } from "@/components/credits/buy-pack-button";
import { buttonVariants } from "@/components/ui/button";
import { integrationHref } from "@/components/settings/sections";
import { useViewerPlan } from "@/components/viewer-plan";
import { noticeCopyFor } from "@/lib/ai-access-copy";
import { PLAN_CONFIG } from "@/lib/plans/plan-config";
import type { AiAccessDenial } from "@/lib/managed-ai-policy";
import { TONE } from "@/lib/tone";
import { cn } from "@/lib/utils";

/**
 * The one message for "AI can't run for you right now". Pages render it from what they
 * already loaded (`reason`); the only thing it reads for itself is the viewer's plan (and when
 * its credits refill), so it pitches the right way out.
 *
 *  - No key on Free: add a key — or Pro and Max, which include AI.
 *  - Out of credits on Free: says when they refill, offering a key or a look at the plans.
 *  - Out of credits: buy a $5 pack, or (Free) compare plans, or (Pro) upgrade to Max, or use a key.
 *    Lifetime has no packs and nothing above it, so it gets the key alone. Nothing is charged
 *    automatically; this is where the person chooses.
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
  feature: "capture" | "chat" | "setup" | "meeting" | "knowledge" | "draft" | "find";
  reason?: AiAccessDenial | null;
  compact?: boolean;
}) {
  const { plan, includedAiAvailable, creditsResetAt } = useViewerPlan();
  const copy = noticeCopyFor(reason ?? null, plan, creditsResetAt);
  // Free at zero keeps everything on phones too: the refill date is the point of that state.
  const freeOut = reason === "managed_limit" && plan === "free";
  const extra = compact && !freeOut ? "hidden sm:inline" : undefined;
  const verb =
    feature === "chat"
      ? "answer questions about your network"
      : feature === "capture"
        ? "extract people from notes"
        : feature === "meeting"
          ? "summarize meetings"
          : feature === "knowledge"
            ? "summarize people and see how they fit your goals"
            : feature === "draft"
              ? "write a follow-up"
              : feature === "find"
                ? "research people on the web"
                : "read your notes and answer questions";
  // "Pro and Max include AI" only to a Free account, and only where it can actually run.
  const offerUpgrade = copy.offer === "upgrade" && plan === "free" && includedAiAvailable;
  const offerCredits = copy.offer === "credits" && PLAN_CONFIG[plan].features.creditPacks;
  const link = "font-medium text-primary underline-offset-2 hover:underline";
  return (
    <div role="status" className={cn("rounded-xl border px-4 py-3 text-sm", TONE.warning.box)}>
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
          {plan === "free" && (
            <Link href="/pricing" className={link}>
              Compare plans
            </Link>
          )}
          {plan === "orbit" && (
            <Link
              href="/settings#settings-plan"
              data-plan="max"
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "border-tier-border bg-tier-surface text-tier-accent hover:bg-tier-accent/15 hover:text-tier-accent"
              )}
            >
              Upgrade to Max
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
