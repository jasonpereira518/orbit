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
import { normalizeSenderBio } from "@/lib/sender-profile";
import { ensureUserSettings } from "@/lib/user-settings";
import { encrypt } from "@/lib/crypto";
import { loadWritingInstructions, saveWritingInstructionsFor } from "@/lib/writing-instructions-store";
import { loadEmailSettings, saveDefaultSendProvider, saveEmailSignature } from "@/lib/email/settings";
import { getSendCapability, type SendCapability } from "@/lib/email/sender";
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
  trackAiKeyAdded,
} from "@/lib/ai-settings-write";
import { z } from "zod";
import { defineAction, failResult } from "@/lib/input/action";
import { track } from "@/lib/product-events";

export const getSettings = defineAction(
  {},
  async (userId) => {
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
);

/**
 * Save how the user describes themselves. Fed to every message Orbit drafts for them.
 *
 * Normalizing on the way in rather than at each read site: this is pasted straight into
 * prompts, where an embedded newline ends the block and turns the remainder into what looks
 * like a fresh instruction.
 */
export const saveSenderBio = defineAction(
  { schema: z.tuple([z.string()]) },
  async (userId, bio: string) => {
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
);

export const saveThemePreference = defineAction(
  { schema: z.tuple([z.enum(["light", "dark", "system"])]) },
  async (userId, theme: ThemePreference) => {
    const db = await getDb();

    await db
      .insert(userSettings)
      .values({ userId, theme })
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: { theme, updatedAt: new Date() },
      });
  }
);

/** The "Keep work history current" switch on the AI settings page. */
export const saveWorkHistoryAutoEnabled = defineAction(
  { schema: z.tuple([z.boolean()]) },
  async (userId, enabled: boolean) => {
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
);

export const saveAiSettings = defineAction(
  { schema: z.tuple([z.looseObject({ provider: z.enum(["gemini", "openai", "anthropic", "openrouter"]), model: z.string().optional(), apiKey: z.string().optional() })]), invalid: failResult },
  async (userId, input: {
    provider: AiProvider;
    model?: string;
    apiKey?: string;
  }) => {
    const provider = resolveAiProvider(input.provider);
    // Only a NEWLY entered key is checked; saving a model change with the key left blank
    // costs no provider call.
    const newKey = input.apiKey?.trim() || null;
    let keyNote: string | null = null;
    if (newKey) {
      const verdict = await checkAiKey(provider, newKey);
      const outcome = keyCheckOutcome(verdict, provider);
      // Returned, not thrown: a thrown message is a digest in production.
      if (!outcome.save) {
        // The verdict is a closed word ("rejected" | "malformed"), never the key or the provider's text.
        track("ai_key_check_failed", { provider, error_kind: verdict }, { userId });
        return { ok: false as const, error: outcome.error };
      }
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
    // Lazy: every page that reads settings imports this file, and the engine is only needed here.
    if (newKey) after(async () => (await import("@/lib/relationship-engine/runner")).kickRelationshipRun(userId));

    revalidatePath("/settings");
    revalidatePath("/chat");
    return {
      ok: true as const,
      embeddingReset,
      keyNote,
    };
  }
);

export const clearApiKey = defineAction(
  { schema: z.tuple([z.enum(["gemini", "openai", "anthropic", "openrouter"]).optional()]) },
  async (userId, provider?: AiProvider) => {
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
);

/**
 * The user's standing notes on how answers and drafts should read — the second box in the
 * chat Context sheet. Applied to chat and to the draft-writing features by the callers that
 * own those requests; nothing here decides where it applies. See `writing-instructions.ts`.
 */
export const getWritingInstructions = defineAction(
  {},
  async (userId) => {
    return { text: await loadWritingInstructions(userId) };
  }
);

/** Saves the notes, or clears them for empty/whitespace-only text. Returns what was stored. */
export const saveWritingInstructions = defineAction(
  { schema: z.tuple([z.string()]) },
  async (userId, text: string) => {
    if (typeof text !== "string") throw new Error("Invalid writing instructions");
    const stored = await saveWritingInstructionsFor(userId, text);
    return { ok: true as const, text: stored };
  }
);

/** The Email settings section: signature, and the mailbox Orbit sends from. */
export const getEmailSettings = defineAction(
  { auth: { surface: "settings.email" } },
  async (userId): Promise<{ signature: string | null; capability: SendCapability }> => {
    const [{ signature }, capability] = await Promise.all([loadEmailSettings(userId), getSendCapability(userId)]);
    return { signature, capability };
  }
);

/** Which connected mailbox sends by default when more than one can. Null = automatic. */
export const saveDefaultSendProviderAction = defineAction(
  { auth: { surface: "settings.email" }, schema: z.tuple([z.enum(["gmail", "outlook"]).nullable()]) },
  async (userId, provider: "gmail" | "outlook" | null): Promise<SendCapability> => {
    await saveDefaultSendProvider(userId, provider === "gmail" || provider === "outlook" ? provider : null);
    return getSendCapability(userId);
  }
);

export const saveEmailSignatureAction = defineAction(
  { auth: { surface: "settings.email" }, schema: z.tuple([z.string()]) },
  async (userId, text: string): Promise<{ ok: true; signature: string | null }> => {
    if (typeof text !== "string") throw new Error("Invalid signature");
    return { ok: true, signature: await saveEmailSignature(userId, text) };
  }
);

/**
 * The decision model's key (TypeSafe's Jev). Its own action, not a branch of
 * `saveAiSettings`: TypeSafe is not a chat provider, so saving it changes no provider, no
 * model and no embedding space — it only lets the steps in `src/lib/decisions/` run.
 */
export const saveDecisionKey = defineAction(
  { schema: z.tuple([z.string()]), invalid: failResult },
  async (userId, apiKey: string) => {
    const key = apiKey.trim();
    if (!key) return { ok: false as const, error: "Paste a TypeSafe key first" };

    const verdict = await checkDecisionKey(key);
    const outcome = keyCheckOutcome(verdict, "typesafe");
    // Returned, not thrown: a thrown message is a digest in production.
    if (!outcome.save) {
      track("ai_key_check_failed", { provider: "typesafe", error_kind: verdict }, { userId });
      return { ok: false as const, error: outcome.error };
    }

    const encrypted = encrypt(key);
    const db = await getDb();
    const before = await db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
      columns: { typesafeApiKeyEncrypted: true, createdAt: true },
    });
    await db
      .insert(userSettings)
      .values({ userId, typesafeApiKeyEncrypted: encrypted })
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: { typesafeApiKeyEncrypted: encrypted, updatedAt: new Date() },
      });

    // The decision key is a personal key too (`ai_key_added`, provider "typesafe"), but it does not
    // make chat AI ready, so it does not stamp `user_settings.ai_key_added_at`.
    if (!before?.typesafeApiKeyEncrypted) {
      await trackAiKeyAdded(userId, "typesafe", before?.createdAt ?? new Date());
    }

    revalidatePath("/settings");
    return { ok: true as const, keyNote: outcome.note };
  }
);

export const clearDecisionKey = defineAction(
  {},
  async (userId) => {
    const db = await getDb();
    await db
      .update(userSettings)
      .set({ typesafeApiKeyEncrypted: null, updatedAt: new Date() })
      .where(eq(userSettings.userId, userId));
    revalidatePathIfRequestScoped("/settings");
    return { ok: true as const };
  }
);

export const saveOutreachSettings = defineAction(
  { schema: z.tuple([z.looseObject({ apolloApiKey: z.string().optional(), resendApiKey: z.string().optional(), twilioAccountSid: z.string().optional(), twilioAuthToken: z.string().optional(), twilioFromNumber: z.string().optional() })]) },
  async (userId, input: {
    apolloApiKey?: string;
    resendApiKey?: string;
    twilioAccountSid?: string;
    twilioAuthToken?: string;
    twilioFromNumber?: string;
  }) => {
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
);

export const saveSocialLinks = defineAction(
  { schema: z.tuple([z.looseObject({ linkedin: z.string().optional(), twitter: z.string().optional(), github: z.string().optional(), website: z.string().optional() })]), invalid: failResult },
  async (userId, input: {
    linkedin?: string;
    twitter?: string;
    github?: string;
    website?: string;
  }) => {
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
);


/** Row counts per category, for the delete dialog. */
export const getDeletableDataFootprint = defineAction(
  {},
  async (userId) => {
    return getDataFootprint(userId);
  }
);

/**
 * Delete the chosen categories of the caller's own data.
 *
 * `categories` is validated against `DATA_CATEGORY_IDS` rather than trusted: this is a
 * server action, so its argument is a request body, and an unrecognised id must not silently
 * widen or narrow a destructive call. An empty selection is a no-op, not a full purge —
 * the failure mode of getting that backwards is unrecoverable.
 */
export const deleteAllData = defineAction(
  { schema: z.tuple([z.array(z.enum(["contacts", "notes", "tags", "reminders", "imports", "recruiters", "chat", "activity", "feedback", "api", "events", "connections", "outreach", "goals", "insights", "preferences"])).optional()]) },
  async (userId, categories?: readonly DataCategory[]) => {
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
);

/** Everything the settings billing card needs, in one round trip. */
export const getPlanOverview = defineAction(
  {},
  async (userId) => {
    const [entitlements, usage] = await Promise.all([
      getEntitlements(userId),
      contactUsageForUser(userId),
    ]);

    return { entitlements, usage, demoAccount: demoAccountReason(userId) };
  }
);


