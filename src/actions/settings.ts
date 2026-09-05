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
import { purgeUserData } from "@/lib/user-data";
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
  usingEnvKey,
  type AiProvider,
} from "@/lib/ai";

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
  const [entitlements, hasApolloKey] = await Promise.all([
    getEntitlements(userId),
    userHasApolloKey(userId),
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
    usingEnvKey: usingEnvKey(provider, settings),
    // Whether "Fill from Apollo" on the contact page has anything to call — computed via
    // the same resolver `fillContactProfileFromApollo` itself uses, not re-derived here.
    hasApolloKey,
    hasApiKey:
      provider === "gemini"
        ? Boolean(settings?.geminiApiKeyEncrypted) ||
          usingEnvKey("gemini", settings)
        : provider === "openai"
          ? Boolean(settings?.openaiApiKeyEncrypted) ||
            usingEnvKey("openai", settings)
          : Boolean(settings?.anthropicApiKeyEncrypted) ||
            usingEnvKey("anthropic", settings),
    providers: AI_PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      envVar: p.envVar,
      hasPersonalKey:
        p.id === "gemini"
          ? Boolean(settings?.geminiApiKeyEncrypted)
          : p.id === "openai"
            ? Boolean(settings?.openaiApiKeyEncrypted)
            : Boolean(settings?.anthropicApiKeyEncrypted),
      usingEnv: usingEnvKey(p.id, settings),
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

async function embeddingBackendFor(
  provider: AiProvider,
  settings: {
    geminiApiKeyEncrypted: string | null;
    openaiApiKeyEncrypted: string | null;
    anthropicApiKeyEncrypted: string | null;
  } | null
) {
  if (provider === "openai") {
    if (settings?.openaiApiKeyEncrypted || usingEnvKey("openai", settings)) {
      return "openai";
    }
    return null;
  }
  if (provider === "gemini") {
    if (settings?.geminiApiKeyEncrypted || usingEnvKey("gemini", settings)) {
      return "gemini";
    }
    return null;
  }
  if (settings?.openaiApiKeyEncrypted || usingEnvKey("openai", settings)) {
    return "openai";
  }
  if (settings?.geminiApiKeyEncrypted || usingEnvKey("gemini", settings)) {
    return "gemini";
  }
  return null;
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

  const previousBackend = existing
    ? await embeddingBackendFor(resolveAiProvider(existing.aiProvider), existing)
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

  const nextBackend = await embeddingBackendFor(provider, nextKeyState);
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

export async function deleteAllData() {
  const userId = await requireUserId();
  await purgeUserData(userId);

  revalidatePath("/");
  revalidatePath("/contacts");
  revalidatePath("/settings");
  revalidatePath("/outreach");
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
