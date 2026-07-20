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

  return {
    aiProvider: provider,
    aiModel: resolveAiModel(provider, settings?.aiModel),
    keys: {
      gemini: Boolean(settings?.geminiApiKeyEncrypted),
      openai: Boolean(settings?.openaiApiKeyEncrypted),
      anthropic: Boolean(settings?.anthropicApiKeyEncrypted),
    },
    usingEnvKey: usingEnvKey(provider, settings),
    hasApiKey:
      provider === "gemini"
        ? Boolean(settings?.geminiApiKeyEncrypted) ||
          Boolean(process.env.GEMINI_API_KEY)
        : provider === "openai"
          ? Boolean(settings?.openaiApiKeyEncrypted) ||
            Boolean(process.env.OPENAI_API_KEY)
          : Boolean(settings?.anthropicApiKeyEncrypted) ||
            Boolean(process.env.ANTHROPIC_API_KEY),
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
      usingEnv:
        p.id === "gemini"
          ? Boolean(process.env.GEMINI_API_KEY) &&
            !settings?.geminiApiKeyEncrypted
          : p.id === "openai"
            ? Boolean(process.env.OPENAI_API_KEY) &&
              !settings?.openaiApiKeyEncrypted
            : Boolean(process.env.ANTHROPIC_API_KEY) &&
              !settings?.anthropicApiKeyEncrypted,
    })),
  };
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
    if (settings?.openaiApiKeyEncrypted || process.env.OPENAI_API_KEY) {
      return "openai";
    }
    return null;
  }
  if (provider === "gemini") {
    if (settings?.geminiApiKeyEncrypted || process.env.GEMINI_API_KEY) {
      return "gemini";
    }
    return null;
  }
  if (settings?.openaiApiKeyEncrypted || process.env.OPENAI_API_KEY) {
    return "openai";
  }
  if (settings?.geminiApiKeyEncrypted || process.env.GEMINI_API_KEY) {
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

/** @deprecated Prefer saveAiSettings */
export async function saveApiKey(apiKey: string, aiModel?: string) {
  return saveAiSettings({
    provider: "gemini",
    apiKey,
    model: aiModel,
  });
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
}
