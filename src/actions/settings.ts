"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  aiSuggestions,
  contactEmbeddings,
  contactTags,
  contacts,
  imports,
  interactions,
  reminders,
  tags,
  userSettings,
} from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { encrypt, decrypt } from "@/lib/crypto";

export async function getSettings() {
  const userId = await requireUserId();
  const db = await getDb();
  const settings = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });

  return {
    hasApiKey: Boolean(settings?.openaiApiKeyEncrypted),
    aiModel: settings?.aiModel || "gpt-4o-mini",
    usingEnvKey: Boolean(process.env.OPENAI_API_KEY) && !settings?.openaiApiKeyEncrypted,
  };
}

export async function saveApiKey(apiKey: string, aiModel?: string) {
  const userId = await requireUserId();
  const db = await getDb();
  const existing = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });

  const encrypted = apiKey.trim() ? encrypt(apiKey.trim()) : null;

  if (existing) {
    await db
      .update(userSettings)
      .set({
        openaiApiKeyEncrypted: encrypted ?? existing.openaiApiKeyEncrypted,
        aiModel: aiModel || existing.aiModel,
        updatedAt: new Date(),
      })
      .where(eq(userSettings.userId, userId));
  } else {
    await db.insert(userSettings).values({
      userId,
      openaiApiKeyEncrypted: encrypted,
      aiModel: aiModel || "gpt-4o-mini",
    });
  }

  revalidatePath("/settings");
  return { ok: true };
}

export async function clearApiKey() {
  const userId = await requireUserId();
  const db = await getDb();
  await db
    .update(userSettings)
    .set({ openaiApiKeyEncrypted: null, updatedAt: new Date() })
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
  const db = await getDb();

  await db.delete(contactEmbeddings).where(eq(contactEmbeddings.userId, userId));
  await db.delete(interactions).where(eq(interactions.userId, userId));
  await db.delete(reminders).where(eq(reminders.userId, userId));
  await db.delete(aiSuggestions).where(eq(aiSuggestions.userId, userId));
  await db.delete(imports).where(eq(imports.userId, userId));

  const userContacts = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
  });
  for (const c of userContacts) {
    await db.delete(contactTags).where(eq(contactTags.contactId, c.id));
  }
  await db.delete(contacts).where(eq(contacts.userId, userId));
  await db.delete(tags).where(eq(tags.userId, userId));
  await db.delete(userSettings).where(eq(userSettings.userId, userId));

  revalidatePath("/");
  revalidatePath("/contacts");
  revalidatePath("/settings");
}

// silence unused import warning for decrypt in case we add verify later
void decrypt;
