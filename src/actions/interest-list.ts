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
import { z } from "zod";
import { defineAction, failMessage } from "@/lib/input/action";

/**
 * The request-reading half of the join. Everything that decides what happens lives in
 * `lib/interest-list-join.ts`, which the smoke test drives without a request.
 */
export const joinInterestList = defineAction(
  // Public: the waitlist is for people without an account. Only the shape is checked here —
  // the core's honeypot must see a bot's input before `interestListSchema` validates it.
  { auth: "public", schema: z.tuple([z.looseObject({})]), invalid: failMessage },
  async (_caller, input: InterestListInput): Promise<InterestListResult> => {
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
);

/** The join's second step: the name for the pass. */
export const saveInterestListName = defineAction(
  // Public, as above; `interestNameSchema` in the core owns the per-field messages.
  { auth: "public", schema: z.tuple([z.looseObject({})]), invalid: failMessage },
  async (_caller, input: InterestNameInput): Promise<InterestNameResult> => {
    if (await isBotRequest()) {
      await recordBotBlocked();
      return { ok: true };
    }
    const ip = clientIpFrom(await headers());
    return saveInterestListNameCore(input, { ip });
  }
);

/**
 * Browser-only pass open. Called when the boarding pass mounts — not when an operator
 * adds someone, and not from email prefetch of `?me=` HTML (no JS → no call).
 */
export const recordPassCheckAction = defineAction(
  // Public: the boarding pass is shared with people who are not signed in.
  { auth: "public", schema: z.tuple([z.string()]) },
  async (_caller, shareToken: string): Promise<void> => {
    const token = typeof shareToken === "string" ? shareToken.trim() : "";
    if (!token || token.length > SHARE_TOKEN_MAX) return;
    try {
      await recordPassCheck(token);
    } catch (err) {
      console.error("[interest-list] pass check failed", err);
    }
  }
);
