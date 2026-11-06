"use server";

import { and, count, countDistinct, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, interactions, userSettings } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { ensureUserSettings } from "@/lib/user-settings";
import { lastCompletedImportAt } from "@/lib/import-history";
import {
  LINKEDIN_IMPORT_TYPE,
  LINKEDIN_MESSAGES_IMPORT_TYPE,
} from "@/lib/import-adapters/linkedin-import-types";
import { getLastLinkedInImportAt } from "@/lib/linkedin-reminder";
import {
  LINKEDIN_REFRESH_INTERVAL_OPTIONS,
  linkedInRefreshLevel,
  type LinkedInRefreshLevel,
} from "@/lib/linkedin-export";
import { EXTENSION_PUBLISHED } from "@/lib/plan-copy";
import { UserFacingError } from "@/lib/errors";

export type LinkedInPanel = {
  /**
   * Newest finished, not-undone upload of either file or the whole export — the bell's own rule
   * (`getLastLinkedInImportAt`), so "Due for a refresh" here and the bell can't disagree.
   */
  lastImportAt: Date | null;
  refreshLevel: LinkedInRefreshLevel;
  /** `user_settings.linkedin_refresh_interval_days`: null = monthly (the default), 0 = off. */
  intervalDays: number | null;
  connections: { people: number; lastAt: Date | null };
  messages: { people: number; lastAt: Date | null };
  /** The person's own profile from their export, or null when it was never imported. */
  aboutYou: {
    headline: string | null;
    role: string | null;
    skills: number;
    importedAt: string | null;
  } | null;
  exportRequestedAt: Date | null;
  workHistoryAuto: boolean;
  /** Null while the extension is unpublished: the switch would govern nothing. */
  savePosts: boolean | null;
};

/** Everything the LinkedIn integration page shows except import history (`listImports`). */
export async function getLinkedInPanel(): Promise<LinkedInPanel> {
  const userId = await requireUserId();
  const db = await getDb();
  const [
    settings,
    lastImportAt,
    connectionsAt,
    messagesAt,
    [connections],
    [messages],
  ] = await Promise.all([
    ensureUserSettings(userId),
    getLastLinkedInImportAt(userId),
    lastCompletedImportAt(userId, [LINKEDIN_IMPORT_TYPE]),
    lastCompletedImportAt(userId, [LINKEDIN_MESSAGES_IMPORT_TYPE]),
    db
      .select({ n: count() })
      .from(contacts)
      .where(and(eq(contacts.userId, userId), eq(contacts.source, "linkedin"))),
    db
      .select({ n: countDistinct(interactions.contactId) })
      .from(interactions)
      .where(
        and(
          eq(interactions.userId, userId),
          eq(interactions.interactionType, "linkedin_message"),
        ),
      ),
  ]);
  const profile = settings.careerProfile ?? null;
  const role = profile?.role
    ? [profile.role.title, profile.role.company].filter(Boolean).join(" at ")
    : null;
  return {
    lastImportAt,
    refreshLevel: linkedInRefreshLevel(
      lastImportAt,
      new Date(),
      settings.linkedinRefreshIntervalDays,
    ),
    intervalDays: settings.linkedinRefreshIntervalDays ?? null,
    connections: { people: Number(connections?.n ?? 0), lastAt: connectionsAt },
    messages: { people: Number(messages?.n ?? 0), lastAt: messagesAt },
    aboutYou:
      profile && (profile.profile?.headline || role || profile.skills?.length)
        ? {
            headline: profile.profile?.headline?.trim() || null,
            role: role || null,
            skills: profile.skills?.length ?? 0,
            importedAt: profile.importedAt ?? null,
          }
        : null,
    exportRequestedAt: settings.linkedinExportRequestedAt ?? null,
    workHistoryAuto: (settings.workHistoryAutoEnabled ?? 1) !== 0,
    savePosts: EXTENSION_PUBLISHED
      ? settings.radarCaptureLinkedinActivity === 1
      : null,
  };
}

/** How often to be nudged for a fresh export: one of the page's choices, 0 = off. */
export async function setLinkedInRefreshInterval(days: number): Promise<void> {
  const userId = await requireUserId();
  if (
    !(LINKEDIN_REFRESH_INTERVAL_OPTIONS as readonly number[]).includes(days)
  ) {
    throw new UserFacingError("Pick one of the reminder options");
  }
  await ensureUserSettings(userId);
  const db = await getDb();
  await db
    .update(userSettings)
    .set({ linkedinRefreshIntervalDays: days, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
}
