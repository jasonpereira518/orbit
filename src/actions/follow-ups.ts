"use server";

import { and, eq, lte, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, followUpSuggestions } from "@/db/schema";
import { listActiveGoalTexts } from "@/actions/goals";
import { requireUserId } from "@/lib/auth";
import { clientAvatarUrlSql } from "@/lib/contact-avatar-sql";
import {
  acceptSuggestion,
  dismissSuggestion,
  markSuggestionSent,
  muteContact,
  snoozeSuggestion,
} from "@/lib/follow-ups/feedback";
import { generateContactFollowUpDraft } from "@/lib/follow-up-drafts";
import { isoDay, startOfDay } from "@/lib/follow-ups/time";
import { revalidateReminderPaths } from "@/lib/reminder-paths";

export type TodaySuggestion = {
  id: string;
  contactId: string;
  contactName: string;
  title: string | null;
  company: string | null;
  avatarUrl: string | null;
  primaryKind: string;
  reason: string;
  hook: string | null;
  signals: { kind: string; evidence: string }[];
};

export async function listTodaySuggestions(): Promise<TodaySuggestion[]> {
  const userId = await requireUserId();
  const db = await getDb();
  const now = new Date();
  // LOCAL day basis, matching how every `dueOn` was written — see `isoDay`'s doc
  // comment in `time.ts`. `now.toISOString().slice(0, 10)` (UTC) diverges from this
  // the moment the process's local date differs from `now`'s UTC date, which
  // over-includes suggestions genuinely dated tomorrow.
  const today = isoDay(startOfDay(now));

  const rows = await db
    .select({
      id: followUpSuggestions.id,
      contactId: followUpSuggestions.contactId,
      primaryKind: followUpSuggestions.primaryKind,
      reason: followUpSuggestions.reason,
      hook: followUpSuggestions.hook,
      signals: followUpSuggestions.signals,
      score: followUpSuggestions.score,
      fullName: contacts.fullName,
      preferredName: contacts.preferredName,
      title: contacts.title,
      company: contacts.company,
      // A `sql` template constant, not a function — do not call it.
      avatarUrl: clientAvatarUrlSql,
    })
    .from(followUpSuggestions)
    .innerJoin(contacts, eq(followUpSuggestions.contactId, contacts.id))
    .where(
      and(
        eq(followUpSuggestions.userId, userId),
        lte(followUpSuggestions.dueOn, today),
        or(
          eq(followUpSuggestions.status, "pending"),
          // A snooze that has elapsed is due again, without needing a pass to run.
          and(
            eq(followUpSuggestions.status, "snoozed"),
            lte(followUpSuggestions.snoozedUntil, now)
          )
        )
      )
    )
    .orderBy(sql`${followUpSuggestions.score} DESC`);

  return rows.map((r) => ({
    id: r.id,
    contactId: r.contactId,
    contactName: r.preferredName?.trim() || r.fullName,
    title: r.title,
    company: r.company,
    avatarUrl: r.avatarUrl,
    primaryKind: r.primaryKind,
    reason: r.reason,
    hook: r.hook,
    signals: (r.signals ?? []).map((s) => ({ kind: s.kind, evidence: s.evidence })),
  }));
}

export async function acceptSuggestionAction(id: string) {
  const userId = await requireUserId();
  const result = await acceptSuggestion(userId, id);
  revalidateReminderPaths(result.contactId);
  return result;
}

export async function snoozeSuggestionAction(id: string, days: number) {
  const userId = await requireUserId();
  const { contactId } = await snoozeSuggestion(userId, id, days);
  revalidateReminderPaths(contactId);
}

export async function dismissSuggestionAction(
  id: string,
  reason: "not_now" | "wrong_reason" | "stop_this_kind"
) {
  const userId = await requireUserId();
  const { contactId } = await dismissSuggestion(userId, id, reason);
  revalidateReminderPaths(contactId);
}

export async function muteSuggestionContactAction(id: string) {
  const userId = await requireUserId();
  const db = await getDb();
  const row = await db.query.followUpSuggestions.findFirst({
    where: and(eq(followUpSuggestions.id, id), eq(followUpSuggestions.userId, userId)),
    columns: { contactId: true },
  });
  if (!row) throw new Error("Suggestion not found");
  await muteContact(userId, row.contactId);
  revalidateReminderPaths(row.contactId);
}

export async function markSentAction(id: string) {
  const userId = await requireUserId();
  const { contactId } = await markSuggestionSent(userId, id);
  revalidateReminderPaths(contactId);
}

/**
 * Draft a message for a suggestion.
 *
 * The hook is passed through as `intent`, which `generateContactFollowUpDraft` already
 * accepts — so the draft is grounded in the same reason the card is showing rather
 * than being a generic warm follow-up. Drafting does NOT accept the suggestion: the
 * user may read the draft and decide not to send it.
 */
export async function draftForSuggestionAction(id: string) {
  const userId = await requireUserId();
  const db = await getDb();
  const row = await db.query.followUpSuggestions.findFirst({
    where: and(eq(followUpSuggestions.id, id), eq(followUpSuggestions.userId, userId)),
    columns: { contactId: true, hook: true, reason: true },
  });
  if (!row) throw new Error("Suggestion not found");

  const goals = await listActiveGoalTexts();
  return generateContactFollowUpDraft(userId, row.contactId, goals, {
    intent: row.hook?.trim() || row.reason,
  });
}
