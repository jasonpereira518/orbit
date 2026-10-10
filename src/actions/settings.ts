"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { revalidatePathIfRequestScoped } from "@/lib/reminder-paths";
import { getDb } from "@/db";
import {
  contactEmbeddings,
  userSettings,
} from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { normalizeSenderBio } from "@/lib/sender-profile";
import { ensureUserSettings } from "@/lib/user-settings";
import { encrypt } from "@/lib/crypto";
import { kickRelationshipRun } from "@/lib/relationship-engine/runner";
import { loadWritingInstructions, saveWritingInstructionsFor } from "@/lib/writing-instructions-store";
import { loadEmailSettings, saveDefaultSendProvider, saveEmailSignature } from "@/lib/email/settings";
import { getSendCapability, type SendCapability } from "@/lib/email/sender";
import { requireUserForSurface } from "@/lib/plan-guards";
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
import { demoAccountReason } from "@/lib/demo-account";
import { normalizeSocialLinks } from "@/lib/safe-links";
import {
  applyAiKeyChange,
  clearedKeyPatch, clearMovesEmbeddings,
  managedEligibilityFor,
} from "@/lib/ai-settings-write";

export async function getSettings() {
  const userId = await requireUserId();
  // The row `requireUserId()` just loaded (request-cached), not a second read of it. That
  // read sat in sequence in front of everything below, so it was a full round trip on
  // every page that shows a settings-dependent notice (chat, capture, settings, a contact).
  // Safe because no action writes settings and then calls this in the same request.
  const settings = await ensureUserSettings(userId);

  const provider = resolveAiProvider(settings?.aiProvider);
  // Run alongside entitlements rather than after: neither depends on the other. The Apollo
  // check is handed the row loaded above, so it neither re-reads user_settings nor
  // re-derives entitlements from a second copy of it. (The AI half deliberately re-reads.)
  const [entitlements, hasApolloKey, ai] = await Promise.all([
    getEntitlements(userId),
    userHasApolloKey(userId, settings),
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
    // Whether an Apollo key is configured, via the same resolver the Apollo calls use.
    hasApolloKey,
    /**
     * Whether the hourly sweep keeps contacts' work history current with web searches on
     * this account's AI key. On unless switched off; see the column in schema.ts.
     */
    workHistoryAutoEnabled: (settings?.workHistoryAutoEnabled ?? 1) !== 0,
    /** Radar's Monday email. On unless switched off (Settings, or its one-click link). */
    radarDigestEnabled: (settings?.radarDigestEnabled ?? 1) !== 0,
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
            : p.id === "anthropic"
              ? Boolean(settings?.anthropicApiKeyEncrypted)
              : Boolean(settings?.openrouterApiKeyEncrypted),
      /** Orbit holds a managed key for this provider AND this account may use it. */
      managedAvailable: Boolean(ai.eligibility) && managedKeysConfigured()[p.id],
      /** Clearing this key moves search to another provider, which drops and rebuilds its index. */
      clearResetsSearch: clearMovesEmbeddings(p.id, settings, ai.eligibility),
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
    senderBio: settings?.senderBio || "",
    /** What the LinkedIn export imports wrote about the user; null when nothing was imported. */
    careerProfile: settings?.careerProfile ?? null,
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

/**
 * Save how the user describes themselves. Fed to every message Orbit drafts for them.
 *
 * Normalizing on the way in rather than at each read site: this is pasted straight into
 * prompts, where an embedded newline ends the block and turns the remainder into what looks
 * like a fresh instruction.
 */
export async function saveSenderBio(bio: string) {
  const userId = await requireUserId();
  const db = await getDb();
  const senderBio = normalizeSenderBio(bio);

  await db
    .insert(userSettings)
    .values({ userId, senderBio })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { senderBio, updatedAt: new Date() },
    });

  revalidatePath("/settings");
  return { senderBio: senderBio ?? "" };
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

/** The "Keep work history current" switch on the AI settings page. */
export async function saveWorkHistoryAutoEnabled(enabled: boolean) {
  const userId = await requireUserId();
  const db = await getDb();
  const value = enabled ? 1 : 0;
  await db
    .insert(userSettings)
    .values({ userId, workHistoryAutoEnabled: value })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { workHistoryAutoEnabled: value, updatedAt: new Date() },
    });
}

export async function saveAiSettings(input: {
  provider: AiProvider;
  model?: string;
  apiKey?: string;
}) {
  const userId = await requireUserId();

  const provider = resolveAiProvider(input.provider);
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

  const { embeddingReset } = await applyAiKeyChange({
    userId,
    provider,
    model: input.model,
    encryptedKey: encrypted,
  });

  // A run parked in waiting_key resumes as soon as AI can run again.
  if (newKey) after(() => kickRelationshipRun(userId));

  revalidatePath("/settings");
  revalidatePath("/chat");
  return {
    ok: true as const,
    embeddingReset,
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

  const patch = clearedKeyPatch(active);

  await db
    .update(userSettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));

  // Clearing a key can move embeddings to another provider — an Anthropic account falls
  // back from OpenAI to Gemini. Vectors from two providers cannot be compared, so stale ones
  // go, by the same rule `saveAiSettings` applies when a save changes the backend.
  let embeddingReset = false;
  if (existing) {
    // Eligibility matters: on Lifetime, clearing a key can move search onto Orbit's managed key.
    embeddingReset = clearMovesEmbeddings(active, existing, await managedEligibilityFor(userId));
    if (embeddingReset) {
      await db.delete(contactEmbeddings).where(eq(contactEmbeddings.userId, userId));
    }
  }

  revalidatePathIfRequestScoped("/settings");
  return { ok: true as const, embeddingReset };
}

/**
 * The user's standing notes on how answers and drafts should read — the second box in the
 * chat Context sheet. Applied to chat and to the draft-writing features by the callers that
 * own those requests; nothing here decides where it applies. See `writing-instructions.ts`.
 */
export async function getWritingInstructions() {
  const userId = await requireUserId();
  return { text: await loadWritingInstructions(userId) };
}

/** Saves the notes, or clears them for empty/whitespace-only text. Returns what was stored. */
export async function saveWritingInstructions(text: string) {
  const userId = await requireUserId();
  if (typeof text !== "string") throw new Error("Invalid writing instructions");
  const stored = await saveWritingInstructionsFor(userId, text);
  return { ok: true as const, text: stored };
}

/** The Email settings section: signature, and the mailbox Orbit sends from. */
export async function getEmailSettings(): Promise<{ signature: string | null; capability: SendCapability }> {
  const userId = await requireUserForSurface("settings.email");
  const [{ signature }, capability] = await Promise.all([loadEmailSettings(userId), getSendCapability(userId)]);
  return { signature, capability };
}

/** Which connected mailbox sends by default when more than one can. Null = automatic. */
export async function saveDefaultSendProviderAction(provider: "gmail" | "outlook" | null): Promise<SendCapability> {
  const userId = await requireUserForSurface("settings.email");
  await saveDefaultSendProvider(userId, provider === "gmail" || provider === "outlook" ? provider : null);
  return getSendCapability(userId);
}

export async function saveEmailSignatureAction(text: string): Promise<{ ok: true; signature: string | null }> {
  const userId = await requireUserForSurface("settings.email");
  if (typeof text !== "string") throw new Error("Invalid signature");
  return { ok: true, signature: await saveEmailSignature(userId, text) };
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
  // Checked here, not only in the field: the stored value becomes a link on the sun's
  // inspect panel, and a Server Action is reachable without this form.
  const normalized = normalizeSocialLinks(input);
  if (!normalized.ok) return normalized;
  const socialLinks = normalized.links;
  const db = await getDb();

  await db
    .insert(userSettings)
    .values({ userId, socialLinks })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { socialLinks, updatedAt: new Date() },
    });

  revalidatePath("/settings");
  revalidatePath("/graph");
  return { ok: true as const, links: socialLinks };
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


