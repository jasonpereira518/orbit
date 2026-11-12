"use client";

import { initBotId } from "botid/client/core";
import { BOTID_PROTECTED_POSTS } from "@/lib/waitlist-host";

let started = false;

/**
 * Attach BotID proofs to waitlist join POSTs. Called from the interest hero so marketing
 * `/` and the signed-in app never pay for BotID on cold start (LATENCY_PLAN #33).
 *
 * Callers: `src/components/interest/interest-hero.tsx` (mount). No prior `ensureBotId`
 * helper existed; `initBotId` previously lived in `src/instrumentation-client.ts`.
 */
export function ensureBotId() {
  if (started || typeof window === "undefined") return;
  started = true;
  initBotId({ protect: BOTID_PROTECTED_POSTS });
}
