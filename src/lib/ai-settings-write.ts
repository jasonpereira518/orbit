/**
 * The AI-settings write shared by `saveAiSettings` (`src/actions/settings.ts`) and the
 * OpenRouter OAuth callback (`src/app/api/openrouter/callback/route.ts`).
 *
 * Deliberately NOT in `src/actions/settings.ts`, even though that is where it was first
 * extracted to. That file starts with `"use server"`, which makes every export a Server
 * Action — reachable via a direct POST with a `Next-Action` header, not only through
 * Orbit's own UI (Next's own docs say so plainly). `applyAiKeyChange` takes a `userId`
 * from its caller rather than deriving one from the session — that is the whole point, so
 * the callback route (which has already checked the session itself) can call it — but as a
 * Server Action that shape lets any signed-in user rewrite another account's `user_settings`
 * row, and delete the victim's `contact_embeddings` in the process if the embedding backend
 * happens to change. Living in a plain module with no `"use server"` closes that off by
 * construction: it has no action id, so it is not reachable by POST at all. It uses `@/db`
 * and no `next/server`, so both callers can import it.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contactEmbeddings, userSettings } from "@/db/schema";
import { resolveAiModel, resolveAiProvider, type AiProvider } from "@/lib/ai";
import { managedKeysConfigured } from "@/lib/ai-access";
import { getEntitlements } from "@/lib/entitlements";
import { isDemoAccount } from "@/lib/demo-account";
import {
  chooseEmbeddingKey,
  managedEligibility,
  type ManagedEligibility,
} from "@/lib/managed-ai-policy";

/**
 * Which embedding backend a given key state would land on — the same policy function the
 * gate runs (`chooseEmbeddingKey`), so a provider switch that moves search onto a different
 * embedding space (including onto or off Orbit's managed key) is detected and the stale
 * vectors cleared.
 */
export function embeddingBackendFor(
  provider: AiProvider,
  settings: {
    geminiApiKeyEncrypted: string | null;
    openaiApiKeyEncrypted: string | null;
    anthropicApiKeyEncrypted: string | null;
    openrouterApiKeyEncrypted: string | null;
  } | null,
  eligibility: ManagedEligibility
) {
  const choice = chooseEmbeddingKey({
    eligibility,
    selectedProvider: provider,
    selectedModel: "",
    personal: {
      gemini: Boolean(settings?.geminiApiKeyEncrypted),
      openai: Boolean(settings?.openaiApiKeyEncrypted),
      anthropic: Boolean(settings?.anthropicApiKeyEncrypted),
      openrouter: Boolean(settings?.openrouterApiKeyEncrypted),
    },
    managed: managedKeysConfigured(),
  });
  return choice.ok ? choice.provider : null;
}

export async function managedEligibilityFor(userId: string): Promise<ManagedEligibility> {
  const { plan } = await getEntitlements(userId);
  return managedEligibility(plan, isDemoAccount(userId));
}

/**
 * The write `saveAiSettings` performs once a key has been checked (or there is none to
 * check) — resolve the model, compare the embedding backend before and after, write the
 * row, and clear `contact_embeddings` when the backend changed. Both callers have already
 * established `userId` from their own session before calling this — `saveAiSettings` via
 * `requireUserId()`, the callback route via its own Clerk check plus the state-cookie
 * comparison — so this function trusts it. `saveAiSettings`'s own behaviour is unchanged —
 * same order, same deletes, same return shape.
 */
export async function applyAiKeyChange(input: {
  userId: string;
  provider: AiProvider;
  model?: string;
  /** Already encrypted (`encrypt()` from `@/lib/crypto`), or null to leave the stored key alone. */
  encryptedKey: string | null;
}): Promise<{ embeddingReset: boolean }> {
  const { userId, provider, model, encryptedKey } = input;
  const db = await getDb();
  const existing = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });

  const aiModel = resolveAiModel(provider, model);

  const eligibility = await managedEligibilityFor(userId);
  const previousBackend = existing
    ? embeddingBackendFor(resolveAiProvider(existing.aiProvider), existing, eligibility)
    : null;

  const nextKeyState = {
    geminiApiKeyEncrypted:
      provider === "gemini" && encryptedKey
        ? encryptedKey
        : (existing?.geminiApiKeyEncrypted ?? null),
    openaiApiKeyEncrypted:
      provider === "openai" && encryptedKey
        ? encryptedKey
        : (existing?.openaiApiKeyEncrypted ?? null),
    anthropicApiKeyEncrypted:
      provider === "anthropic" && encryptedKey
        ? encryptedKey
        : (existing?.anthropicApiKeyEncrypted ?? null),
    openrouterApiKeyEncrypted:
      provider === "openrouter" && encryptedKey
        ? encryptedKey
        : (existing?.openrouterApiKeyEncrypted ?? null),
  };

  if (existing) {
    await db
      .update(userSettings)
      .set({
        aiProvider: provider,
        aiModel,
        // They have now seen the model they are on and chosen: the notice is spent.
        aiModelMigratedFrom: null,
        ...nextKeyState,
        updatedAt: new Date(),
      })
      .where(eq(userSettings.userId, userId));
  } else {
    await db.insert(userSettings).values({
      userId,
      aiProvider: provider,
      aiModel,
      ...nextKeyState,
    });
  }

  const nextBackend = embeddingBackendFor(provider, nextKeyState, eligibility);
  const embeddingReset = Boolean(previousBackend && nextBackend && previousBackend !== nextBackend);
  if (embeddingReset) {
    // Different embedding spaces can't be compared — clear stale vectors.
    await db.delete(contactEmbeddings).where(eq(contactEmbeddings.userId, userId));
  }

  return { embeddingReset };
}
