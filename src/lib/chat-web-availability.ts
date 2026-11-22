import { webSearchPaused, type AiAccess } from "@/lib/ai-access";
import { WEB_SEARCH_MANAGED_EXCLUDED, chooseCompletionKey } from "@/lib/managed-ai-policy";
import type { WebAvailability } from "@/lib/chat-web-decision";

/**
 * Whether a web search could run for this account right now, asked BEFORE the answer offers
 * the lookup tools so a paused or searchless setup answers from the records and says so
 * instead of handing the model tools that can only be refused.
 *
 * Two things are read, both cheap: the admin web-search switch (the 30-second cached pool
 * read the AI gate already makes) and whether `webSearchJson` would find a key to run on —
 * the same `chooseCompletionKey` call, with the same managed-Gemini exclusion. The per-account
 * month, Orbit's day and the plan are NOT checked here: they are enforced at the call
 * (`reserveWebSearch`, `requireReleasedSurface`), and a refusal there reaches the model as a
 * tool error it reports. Never throws — an unreadable switch is "available", and the call decides.
 */
export async function chatWebAvailability(access: AiAccess | undefined): Promise<WebAvailability> {
  if (await webSearchPaused().catch(() => false)) return { ok: false, why: "paused" };
  if (access && !chooseCompletionKey(access.facts(), { skipManaged: WEB_SEARCH_MANAGED_EXCLUDED }).ok) {
    return { ok: false, why: "no_provider" };
  }
  return { ok: true };
}
