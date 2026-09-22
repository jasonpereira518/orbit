"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { revalidatePathIfRequestScoped } from "@/lib/reminder-paths";
import { getDb } from "@/db";
import {
  contactEmbeddings,
  userSettings,
} from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { ensureUserSettings } from "@/lib/user-settings";
import { encrypt } from "@/lib/crypto";
import {
  DATA_CATEGORY_IDS,
  deletionOutcome,
  getDataFootprint,
  purgeUserData,
  type DataCategory,
} from "@/lib/user-data";
import { getEntitlements } from "@/lib/entitlements";
import { userHasApolloKey } from "@/lib/apollo";
import { contactUsageForUser } from "@/lib/contact-writes";
import {
  resolveThemePreference,
  type ThemePreference,
} from "@/lib/theme";
import {
  AI_PROVIDERS,
  resolveAiModel,
  resolveAiProvider,
  type AiProvider,
} from "@/lib/ai";
import { checkAiKey, checkDecisionKey, keyCheckOutcome } from "@/lib/ai-key-check";
import { getAiAccessStatus, jevSwitchedOff, managedKeysConfigured } from "@/lib/ai-access";
import {
  chooseEmbeddingKey,
  managedEligibility,
  type ManagedEligibility,
} from "@/lib/managed-ai-policy";
import { demoAccountReason, isDemoAccount } from "@/lib/demo-account";

export async function getSettings() {
  const userId = await requireUserId();
  // The row `requireUserId()` just loaded (request-cached), not a second read of it. That
  // read sat in sequence in front of everything below, so it was a full round trip on
  // every page that shows a settings-dependent notice (chat, capture, settings, a contact).
  // Safe because no action writes settings and then calls this in the same request.
  const settings = await ensureUserSettings(userId);

  const provider = resolveAiProvider(settings?.aiProvider);
  // Run alongside entitlements rather than after: neither depends on the other, and
  // `userHasApolloKey` already re-derives entitlements internally for its own hosted-key
  // check, so serializing them would only add latency.
  const [entitlements, hasApolloKey, ai] = await Promise.all([
    getEntitlements(userId),
    userHasApolloKey(userId),
    getAiAccessStatus(userId),
  ]);
  // Mirrors the two runtime resolvers so this card states what would actually be used:
  // `sending` follows the env fallback in `getOutreachSendConfig`, `enrichment` follows
  // the one in `getApolloApiKey`. They diverge on Lifetime, so they cannot share a flag.
  const hostedSending = entitlements.canUseHostedSending;
  const hostedEnrichment = entitlements.canUseHostedEnrichment;

  return {
    aiProvider: provider,
    aiModel: resolveAiModel(provider, settings?.aiModel),
    /**
     * The model this account was moved off when a default changed under it. Settings says
     * so once, and offers the old model back; saving anything clears it.
     */
    aiModelMigratedFrom: settings?.aiModelMigratedFrom ?? null,
    theme: resolveThemePreference(settings?.theme),
    keys: {
      gemini: Boolean(settings?.geminiApiKeyEncrypted),
      openai: Boolean(settings?.openaiApiKeyEncrypted),
      anthropic: Boolean(settings?.anthropicApiKeyEncrypted),
    },
    /**
     * The optional decision model (TypeSafe's Jev) behind the recruiter scan's filters and
     * the chat rerank. Presence only; `switchedOff` is the `ORBIT_JEV=off` kill switch.
     */
    decisionModel: {
      keySaved: Boolean(settings?.typesafeApiKeyEncrypted),
      switchedOff: jevSwitchedOff(),
    },
    /**
     * The AI gate's view of this account — plan-aware, allowance-aware. Everything that says
     * "add your key" or "Orbit covers AI" renders from this, never from key presence alone.
     */
    ai,
    // Whether "Fill from Apollo" on the contact page has anything to call — computed via
    // the same resolver `fillContactProfileFromApollo` itself uses, not re-derived here.
    hasApolloKey,
    /**
     * Whether AI features will run — NOT whether a key is saved. A Lifetime account on
     * Orbit's managed key is `true` with no key at all; a Lifetime account that has used its
     * month's allowance is `false` even with none missing. The name predates plans; ~20
     * components read it to decide between the feature and the "add your key" notice, and
     * that is exactly the question `ai.ready` answers.
     */
    hasApiKey: ai.ready,
    providers: AI_PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      hasPersonalKey:
        p.id === "gemini"
          ? Boolean(settings?.geminiApiKeyEncrypted)
          : p.id === "openai"
            ? Boolean(settings?.openaiApiKeyEncrypted)
            : Boolean(settings?.anthropicApiKeyEncrypted),
      /** Orbit holds a managed key for this provider AND this account may use it. */
      managedAvailable: Boolean(ai.eligibility) && managedKeysConfigured()[p.id],
    })),
    // Mirrors the plan gate in `getOutreachSendConfig` / `getApolloApiKey`: Orbit's shared
    // keys only count as configured when the plan actually permits hosted sends, so the
    // UI never reports a capability the send path will refuse.
    outreach: {
      apollo:
        Boolean(settings?.apolloApiKeyEncrypted) ||
        (hostedEnrichment && Boolean(process.env.APOLLO_API_KEY)),
      resend:
        Boolean(settings?.resendApiKeyEncrypted) ||
        (hostedSending && Boolean(process.env.RESEND_API_KEY)),
      twilio:
        (Boolean(settings?.twilioAccountSidEncrypted) ||
          (hostedSending && Boolean(process.env.TWILIO_ACCOUNT_SID))) &&
        (Boolean(settings?.twilioAuthTokenEncrypted) ||
          (hostedSending && Boolean(process.env.TWILIO_AUTH_TOKEN))) &&
        Boolean(
          settings?.twilioFromNumber ||
            (hostedSending ? process.env.TWILIO_FROM_NUMBER : null)
        ),
      twilioFromNumber:
        settings?.twilioFromNumber ||
        (hostedSending ? process.env.TWILIO_FROM_NUMBER : null) ||
        null,
    },
    plan: {
      plan: entitlements.plan,
      source: entitlements.source,
      contactLimit: entitlements.contactLimit,
      canUseOutreach: entitlements.canUseOutreach,
      canUseHostedSending: entitlements.canUseHostedSending,
      canUseHostedEnrichment: entitlements.canUseHostedEnrichment,
      canUseRecruiters: entitlements.canUseRecruiters,
      canUseSync: entitlements.canUseSync,
      canUseExtension: entitlements.canUseExtension,
    },
    socialLinks: {
      linkedin: settings?.socialLinks?.linkedin || "",
      twitter: settings?.socialLinks?.twitter || "",
      github: settings?.socialLinks?.github || "",
      website: settings?.socialLinks?.website || "",
    },
    /** Null until the account has recorded a choice — see the column in schema.ts. */
    desktopNotificationsEnabled: settings?.desktopNotificationsEnabled ?? null,
  };
}

export async function saveThemePreference(theme: ThemePreference) {
  const userId = await requireUserId();
  const db = await getDb();

  await db
    .insert(userSettings)
    .values({ userId, theme })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { theme, updatedAt: new Date() },
    });
}

/**
 * Which embedding backend a given key state would land on — the same policy function the
 * gate runs (`chooseEmbeddingKey`), so a provider switch that moves search onto a different
 * embedding space (including onto or off Orbit's managed key) is detected and the stale
 * vectors cleared.
 */
function embeddingBackendFor(
  provider: AiProvider,
  settings: {
    geminiApiKeyEncrypted: string | null;
    openaiApiKeyEncrypted: string | null;
    anthropicApiKeyEncrypted: string | null;
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
    },
    managed: managedKeysConfigured(),
  });
  return choice.ok ? choice.provider : null;
}

async function managedEligibilityFor(userId: string): Promise<ManagedEligibility> {
  const { plan } = await getEntitlements(userId);
  return managedEligibility(plan, isDemoAccount(userId));
}

export async function saveAiSettings(input: {
  provider: AiProvider;
  model?: string;
  apiKey?: string;
}) {
  const userId = await requireUserId();
  const db = await getDb();
  const existing = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });

  const provider = resolveAiProvider(input.provider);
  const aiModel = resolveAiModel(provider, input.model);
  // Only a NEWLY entered key is checked; saving a model change with the key left blank
  // costs no provider call.
  const newKey = input.apiKey?.trim() || null;
  let keyNote: string | null = null;
  if (newKey) {
    const outcome = keyCheckOutcome(await checkAiKey(provider, newKey), provider);
    // Returned, not thrown: a thrown message is a digest in production.
    if (!outcome.save) return { ok: false as const, error: outcome.error };
    keyNote = outcome.note;
  }
  const encrypted = newKey ? encrypt(newKey) : null;

  const eligibility = await managedEligibilityFor(userId);
  const previousBackend = existing
    ? embeddingBackendFor(resolveAiProvider(existing.aiProvider), existing, eligibility)
    : null;

  const nextKeyState = {
    geminiApiKeyEncrypted:
      provider === "gemini" && encrypted
        ? encrypted
        : (existing?.geminiApiKeyEncrypted ?? null),
    openaiApiKeyEncrypted:
      provider === "openai" && encrypted
        ? encrypted
        : (existing?.openaiApiKeyEncrypted ?? null),
    anthropicApiKeyEncrypted:
      provider === "anthropic" && encrypted
        ? encrypted
        : (existing?.anthropicApiKeyEncrypted ?? null),
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
  if (
    previousBackend &&
    nextBackend &&
    previousBackend !== nextBackend
  ) {
    // Different embedding spaces can't be compared — clear stale vectors.
    await db
      .delete(contactEmbeddings)
      .where(eq(contactEmbeddings.userId, userId));
  }

  revalidatePath("/settings");
  revalidatePath("/chat");
  return {
    ok: true as const,
    embeddingReset: Boolean(previousBackend && nextBackend && previousBackend !== nextBackend),
    keyNote,
  };
}

export async function clearApiKey(provider?: AiProvider) {
  const userId = await requireUserId();
  const db = await getDb();
  const existing = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });
  const active = resolveAiProvider(provider || existing?.aiProvider);

  const patch =
    active === "gemini"
      ? { geminiApiKeyEncrypted: null }
      : active === "openai"
        ? { openaiApiKeyEncrypted: null }
        : { anthropicApiKeyEncrypted: null };

  await db
    .update(userSettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));

  // Clearing a key can move embeddings to another provider — an Anthropic account falls
  // back from OpenAI to Gemini. Vectors from two providers cannot be compared, so stale ones
  // go, by the same rule `saveAiSettings` applies when a save changes the backend.
  let embeddingReset = false;
  if (existing) {
    const selected = resolveAiProvider(existing.aiProvider);
    // Eligibility matters: on Lifetime, clearing a key can move search onto Orbit's managed key.
    const eligibility = await managedEligibilityFor(userId);
    const previousBackend = embeddingBackendFor(selected, existing, eligibility);
    const nextBackend = embeddingBackendFor(selected, { ...existing, ...patch }, eligibility);
    embeddingReset = Boolean(previousBackend && nextBackend && previousBackend !== nextBackend);
    if (embeddingReset) {
      await db.delete(contactEmbeddings).where(eq(contactEmbeddings.userId, userId));
    }
  }

  revalidatePathIfRequestScoped("/settings");
  return { ok: true as const, embeddingReset };
}

/**
 * The decision model's key (TypeSafe's Jev). Its own action, not a branch of
 * `saveAiSettings`: TypeSafe is not a chat provider, so saving it changes no provider, no
 * model and no embedding space — it only lets the steps in `src/lib/decisions/` run.
 */
export async function saveDecisionKey(apiKey: string) {
  const userId = await requireUserId();
  const key = apiKey.trim();
  if (!key) return { ok: false as const, error: "Paste a TypeSafe key first" };

  const outcome = keyCheckOutcome(await checkDecisionKey(key), "typesafe");
  // Returned, not thrown: a thrown message is a digest in production.
  if (!outcome.save) return { ok: false as const, error: outcome.error };

  const encrypted = encrypt(key);
  const db = await getDb();
  await db
    .insert(userSettings)
    .values({ userId, typesafeApiKeyEncrypted: encrypted })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { typesafeApiKeyEncrypted: encrypted, updatedAt: new Date() },
    });

  revalidatePath("/settings");
  return { ok: true as const, keyNote: outcome.note };
}

export async function clearDecisionKey() {
  const userId = await requireUserId();
  const db = await getDb();
  await db
    .update(userSettings)
    .set({ typesafeApiKeyEncrypted: null, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
  revalidatePathIfRequestScoped("/settings");
  return { ok: true as const };
}

export async function saveOutreachSettings(input: {
  apolloApiKey?: string;
  resendApiKey?: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFromNumber?: string;
}) {
  const userId = await requireUserId();
  const db = await getDb();
  const existing = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });

  const patch = {
    apolloApiKeyEncrypted: input.apolloApiKey?.trim()
      ? encrypt(input.apolloApiKey.trim())
      : (existing?.apolloApiKeyEncrypted ?? null),
    resendApiKeyEncrypted: input.resendApiKey?.trim()
      ? encrypt(input.resendApiKey.trim())
      : (existing?.resendApiKeyEncrypted ?? null),
    twilioAccountSidEncrypted: input.twilioAccountSid?.trim()
      ? encrypt(input.twilioAccountSid.trim())
      : (existing?.twilioAccountSidEncrypted ?? null),
    twilioAuthTokenEncrypted: input.twilioAuthToken?.trim()
      ? encrypt(input.twilioAuthToken.trim())
      : (existing?.twilioAuthTokenEncrypted ?? null),
    twilioFromNumber: input.twilioFromNumber?.trim()
      ? input.twilioFromNumber.trim()
      : (existing?.twilioFromNumber ?? null),
    updatedAt: new Date(),
  };

  if (existing) {
    await db
      .update(userSettings)
      .set(patch)
      .where(eq(userSettings.userId, userId));
  } else {
    await db.insert(userSettings).values({ userId, ...patch });
  }

  revalidatePath("/settings");
  revalidatePath("/outreach");
  return { ok: true };
}

export async function saveSocialLinks(input: {
  linkedin?: string;
  twitter?: string;
  github?: string;
  website?: string;
}) {
  const userId = await requireUserId();
  const db = await getDb();

  const socialLinks = {
    linkedin: input.linkedin?.trim() || undefined,
    twitter: input.twitter?.trim() || undefined,
    github: input.github?.trim() || undefined,
    website: input.website?.trim() || undefined,
  };

  await db
    .insert(userSettings)
    .values({ userId, socialLinks })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { socialLinks, updatedAt: new Date() },
    });

  revalidatePath("/settings");
  revalidatePath("/graph");
  return { ok: true };
}


/** Row counts per category, for the delete dialog. */
export async function getDeletableDataFootprint() {
  const userId = await requireUserId();
  return getDataFootprint(userId);
}

/**
 * Delete the chosen categories of the caller's own data.
 *
 * `categories` is validated against `DATA_CATEGORY_IDS` rather than trusted: this is a
 * server action, so its argument is a request body, and an unrecognised id must not silently
 * widen or narrow a destructive call. An empty selection is a no-op, not a full purge —
 * the failure mode of getting that backwards is unrecoverable.
 */
export async function deleteAllData(categories?: readonly DataCategory[]) {
  const userId = await requireUserId();

  let only: DataCategory[] | undefined;
  if (categories) {
    only = categories.filter((c): c is DataCategory =>
      (DATA_CATEGORY_IDS as string[]).includes(c)
    );
    if (only.length === 0) return { deleted: [] as DataCategory[], pending: [] as DataCategory[] };
  }

  const result = await deletionOutcome(() => purgeUserData(userId, only ? { only } : {}));

  revalidatePath("/");
  revalidatePath("/contacts");
  revalidatePath("/settings");
  revalidatePath("/outreach");

  return result;
}

/** Everything the settings billing card needs, in one round trip. */
export async function getPlanOverview() {
  const userId = await requireUserId();
  const [entitlements, usage] = await Promise.all([
    getEntitlements(userId),
    contactUsageForUser(userId),
  ]);

  return { entitlements, usage, demoAccount: demoAccountReason(userId) };
}
