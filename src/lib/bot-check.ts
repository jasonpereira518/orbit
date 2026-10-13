import { checkBotId } from "botid/server";

/**
 * Vercel BotID's verdict on the current request (`instrumentation-client.ts` lists the
 * paths whose POSTs carry the browser's proof). Off Vercel the package answers "human"
 * itself outside production, so local dev and the smoke harness pass straight through.
 *
 * A check that throws — BotID unreachable, or a production build running off Vercel —
 * answers "not a bot": the join's per-IP limit and the global welcome cap still stand
 * behind it, and failing closed would turn a Vercel outage into a closed waitlist.
 */
export async function isBotRequest(): Promise<boolean> {
  if (testVerdict) return testVerdict();
  try {
    return (await checkBotId()).isBot;
  } catch (err) {
    console.error("[bot-check] BotID check failed", err);
    return false;
  }
}

let testVerdict: (() => Promise<boolean>) | null = null;

/** Test seam: replace BotID's verdict until called with null. */
export function setBotCheckForTests(fn: (() => Promise<boolean>) | null): void {
  testVerdict = fn;
}
