/**
 * Gathers the facts `evaluateOutreachReadiness` needs.
 *
 * Split from the evaluator for the usual reason in this codebase: the rules are worth
 * asserting in a smoke test without a database, and the strip that renders them is reached
 * from a client component. Everything that opens a connection lives here.
 *
 * COST. This runs on two server-rendered pages, so it reuses what is already loaded rather
 * than asking again: `getOutreachSendConfig` resolves every send credential in one settings
 * read and already applies the plan gate on the hosted fallback, and `getApolloApiKey` and
 * `getEntitlements` are the same pair the wizard already calls. `countSendsToday` is one
 * aggregate. The campaign facts are computed from prospects the page has in hand — no
 * query at all.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { managedKeysConfigured } from "@/lib/ai-access";
import type { AiProvider } from "@/lib/ai-providers";
import { AI_PROVIDERS, resolveAiProvider } from "@/lib/ai-providers";
import { userHasApolloKey } from "@/lib/apollo";
import { canAutoSend } from "@/lib/outreach-channels";
import {
  evaluateOutreachReadiness,
  type ReadinessFacts,
  type ReadinessItem,
} from "@/lib/outreach-readiness";
import { countSendsToday, getOutreachSendConfig } from "@/lib/outreach-send";
import type { OutreachChannel } from "@/lib/outreach-types";

/** A prospect as the campaign page already has it — no extra columns fetched for this. */
export type ReadinessProspect = {
  status: string;
  email?: string | null;
  phone?: string | null;
  externalId?: string | null;
  enrichment?: unknown;
};

/**
 * Which prospects a send would actually attempt.
 *
 * "Selected" is the `selected` status the prospect table sets; a `suggested` row the user
 * has not chosen is not part of this campaign's send and must not drag the strip red.
 */
export function campaignReadinessFacts(
  channel: OutreachChannel,
  prospects: ReadinessProspect[]
): NonNullable<ReadinessFacts["campaign"]> {
  const selected = prospects.filter((p) => p.status === "selected");
  return {
    channel,
    selected: selected.length,
    sendable: selected.filter((p) => canAutoSend(channel, p)).length,
  };
}

/**
 * Whether an AI call could be made for this provider at all.
 *
 * Local to this module after the merge of main: this used to call `hasAiKeyFor` in
 * `@/lib/ai`, which main's AI-gating rework removed. Main keeps the equivalent private in
 * `ai-access.ts`, and the readiness strip only needs the question answered, not the
 * machinery — so it asks it here rather than re-opening that module's surface.
 *
 * Personal key first, then a managed key configured for the deployment: either one means a
 * draft can actually be generated, which is the only thing this strip reports.
 */
function hasAiKeyFor(
  provider: AiProvider,
  settings:
    | {
        geminiApiKeyEncrypted?: string | null;
        openaiApiKeyEncrypted?: string | null;
        anthropicApiKeyEncrypted?: string | null;
      }
    | null
    | undefined
): boolean {
  const personal =
    provider === "gemini"
      ? settings?.geminiApiKeyEncrypted
      : provider === "openai"
        ? settings?.openaiApiKeyEncrypted
        : provider === "anthropic"
          ? settings?.anthropicApiKeyEncrypted
          : null;
  if (personal) return true;
  return Boolean(managedKeysConfigured()[provider]);
}

export async function getOutreachReadiness(
  userId: string,
  campaign?: NonNullable<ReadinessFacts["campaign"]>
): Promise<ReadinessItem[]> {
  const db = await getDb();
  const [settings, sendConfig, hasApolloKey, sentToday] = await Promise.all([
    db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) }),
    getOutreachSendConfig(userId),
    userHasApolloKey(userId),
    countSendsToday(userId),
  ]);

  const provider = resolveAiProvider(settings?.aiProvider);

  return evaluateOutreachReadiness({
    hasApolloKey,
    hasAiKey: hasAiKeyFor(provider, settings),
    aiProvider: AI_PROVIDERS.find((p) => p.id === provider)?.label ?? provider,
    hasResendKey: Boolean(sendConfig.resendApiKey),
    fromEmail: sendConfig.fromEmail,
    // All three, because `sendOutreachMessage` requires all three — a SID with no from
    // number is not "partly ready", it is a send that throws.
    hasTwilio: Boolean(
      sendConfig.twilioAccountSid &&
        sendConfig.twilioAuthToken &&
        sendConfig.twilioFromNumber
    ),
    sentToday,
    campaign,
  });
}
