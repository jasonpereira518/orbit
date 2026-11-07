"use server";

import { clientIpFrom } from "@/lib/client-ip";
import { cookies, headers } from "next/headers";
import { ATTRIBUTION_COOKIE, parseAttribution } from "@/lib/attribution-parse";
import type { InterestListResult, InterestNameResult } from "@/lib/interest-list";
import type { InterestListInput, InterestNameInput } from "@/lib/interest-list-schema";
import { SHARE_TOKEN_MAX } from "@/lib/interest-list";
import { joinInterestListCore, plausibleTicket, saveInterestListNameCore } from "@/lib/interest-list-join";
import { isBotRequest, recordBotBlocked } from "@/lib/bot-check";
import { recordPassCheck } from "@/lib/interest-list-ticket";
import { recordWaitlistShareCore } from "@/lib/waitlist-share";

/**
 * The request-reading half of the join. Everything that decides what happens lives in
 * `lib/interest-list-join.ts`, which the smoke test drives without a request.
 */
export async function joinInterestList(
  input: InterestListInput
): Promise<InterestListResult> {
  // BotID first. A bot gets what a rate-limited caller gets: a ticket that resolves to nothing.
  if (await isBotRequest()) {
    await recordBotBlocked();
    return { ok: true, ticket: await plausibleTicket(), returning: false };
  }

  const headerList = await headers();
  const ip = clientIpFrom(headerList);

  const cookieStore = await cookies();
  const attribution = parseAttribution(cookieStore.get(ATTRIBUTION_COOKIE)?.value ?? null);

  return joinInterestListCore(input, { ip, attribution });
}

/** The join's second step: the name for the pass. */
export async function saveInterestListName(
  input: InterestNameInput
): Promise<InterestNameResult> {
  if (await isBotRequest()) {
    await recordBotBlocked();
    return { ok: true };
  }
  const ip = clientIpFrom(await headers());
  return saveInterestListNameCore(input, { ip });
}

/**
 * Browser-only pass open. Called when the boarding pass mounts — not when an operator
 * adds someone, and not from email prefetch of `?me=` HTML (no JS → no call).
 */
export async function recordPassCheckAction(shareToken: string): Promise<void> {
  const token = typeof shareToken === "string" ? shareToken.trim() : "";
  if (!token || token.length > SHARE_TOKEN_MAX) return;
  try {
    await recordPassCheck(token);
  } catch (err) {
    console.error("[interest-list] pass check failed", err);
  }
}

/**
 * A share control was used on the pass (copy, native share sheet, LinkedIn). Callable by any
 * visitor: the share token is the credential and the only thing recorded is the signup id and
 * the channel. Always resolves with nothing, so it cannot be used to probe tokens and a failure
 * is invisible to the person sharing. See `src/lib/waitlist-share.ts`.
 */
export async function recordWaitlistShare(input: {
  shareToken: string;
  channel: string;
}): Promise<void> {
  try {
    if (await isBotRequest()) return;
    const ip = clientIpFrom(await headers());
    await recordWaitlistShareCore({ shareToken: input?.shareToken, channel: input?.channel, ip });
  } catch {
    // A share must never fail on account of its own counter.
  }
}
