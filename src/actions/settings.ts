"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  aiSuggestions,
  contactEmbeddings,
  contacts,
  imports,
  interactions,
  reminders,
  tags,
  userSettings,
} from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { encrypt } from "@/lib/crypto";
import {
  DATA_CATEGORY_IDS,
  expandCategories,
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
import { getAiAccessStatus, managedKeysConfigured } from "@/lib/ai-access";
import {
  chooseEmbeddingKey,
  managedEligibility,
  type ManagedEligibility,
} from "@/lib/managed-ai-policy";
import { isDemoAccount } from "@/lib/demo-account";

export async function getSettings() {
  const userId = await requireUserId();
  const db = await getDb();
  const settings = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });

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
    theme: resolveThemePreference(settings?.theme),
    keys: {
      gemini: Boolean(settings?.geminiApiKeyEncrypted),
      openai: Boolean(settings?.openaiApiKeyEncrypted),
      anthropic: Boolean(settings?.anthropicApiKeyEncrypted),
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
     * Whether voice capture will try Wispr first.
     *
     * Presence only, like `keys` above — this decides whether the capture panel is
     * entitled to say "Wispr didn't answer", and a rejected key still counts as
     * configured, since that is precisely the case worth reporting.
     */
    hasWisprKey: Boolean(settings?.wisprApiKeyEncrypted),
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
  const encrypted = input.apiKey?.trim()
    ? encrypt(input.apiKey.trim())
    : null;

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
  return { ok: true, embeddingReset: Boolean(previousBackend && nextBackend && previousBackend !== nextBackend) };
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
  revalidatePath("/settings");
}

/**
 * Store or clear the Wispr transcription key.
 *
 * Its own action rather than a field on `saveAiSettings`, because Wispr is not an
 * `AiProvider`: it transcribes and never completes, so it takes no part in provider or
 * model selection and none of that action's re-indexing logic applies to it.
 *
 * An empty string clears the key; `undefined` leaves it untouched. That asymmetry is what
 * lets the settings form send the field unconditionally without wiping a stored key every
 * time an unrelated control is saved.
 */
export async function saveVoiceSettings(input: { wisprApiKey?: string }) {
  const userId = await requireUserId();
  const db = await getDb();
  const existing = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });

  const trimmed = input.wisprApiKey?.trim();
  const wisprApiKeyEncrypted =
    input.wisprApiKey === undefined
      ? (existing?.wisprApiKeyEncrypted ?? null)
      : trimmed
        ? encrypt(trimmed)
        : null;

  if (existing) {
    await db
      .update(userSettings)
      .set({ wisprApiKeyEncrypted, updatedAt: new Date() })
      .where(eq(userSettings.userId, userId));
  } else {
    await db.insert(userSettings).values({ userId, wisprApiKeyEncrypted });
  }

  revalidatePath("/settings");
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

export async function exportAllData() {
  const userId = await requireUserId();
  const db = await getDb();

  const [
    contactRows,
    interactionRows,
    reminderRows,
    tagRows,
    importRows,
    suggestionRows,
  ] = await Promise.all([
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      with: { contactTags: { with: { tag: true } } },
    }),
    db.query.interactions.findMany({ where: eq(interactions.userId, userId) }),
    db.query.reminders.findMany({ where: eq(reminders.userId, userId) }),
    db.query.tags.findMany({ where: eq(tags.userId, userId) }),
    db.query.imports.findMany({ where: eq(imports.userId, userId) }),
    db.query.aiSuggestions.findMany({
      where: eq(aiSuggestions.userId, userId),
    }),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    contacts: contactRows,
    interactions: interactionRows,
    reminders: reminderRows,
    tags: tagRows,
    imports: importRows,
    suggestions: suggestionRows,
  };
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
    if (only.length === 0) return { deleted: [] as DataCategory[] };
  }

  await purgeUserData(userId, only ? { only } : {});

  revalidatePath("/");
  revalidatePath("/contacts");
  revalidatePath("/settings");
  revalidatePath("/outreach");

  return {
    deleted: only ? [...expandCategories(only)] : [...DATA_CATEGORY_IDS],
  };
}

/** Everything the settings billing card needs, in one round trip. */
export async function getPlanOverview() {
  const userId = await requireUserId();
  const [entitlements, usage] = await Promise.all([
    getEntitlements(userId),
    contactUsageForUser(userId),
  ]);

  return { entitlements, usage };
}
