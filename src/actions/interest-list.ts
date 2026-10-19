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
import { reportError } from "@/lib/report-error";

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
    reportError(err, { where: "interest.pass.check", level: "warning" });
  }
}
