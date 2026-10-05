import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contactTags, contacts, tags, type ClosenessTier } from "@/db/schema";
import {
  getContactBrief,
  goalFitOutOfDate,
  isBriefStale,
  type RecentDiscussion,
} from "@/lib/contact-brief";
import { getCareerLines } from "@/lib/contact-profile";
import { listEventsTogetherForContact, type EventTogether } from "@/lib/events/people-store";
import { getRecentMoveLines } from "@/lib/job-changes";
import { formatHowMetSummary } from "@/lib/met-context";
import { listActiveGoalsForUser } from "@/lib/user-goals";

export type DossierGoalFit = {
  goalId: string;
  goalText: string;
  why: string;
};

export type KnowledgeDossier = {
  contact: {
    id: string;
    fullName: string;
    preferredName: string | null;
    firstName: string | null;
    title: string | null;
    company: string | null;
    location: string | null;
    hasPhoto: boolean;
    closenessTier: ClosenessTier | null;
    lastInteractionAt: Date | null;
    aiSummary: string | null;
    keyFacts: string[];
    howMet: string | null;
  };
  /** Null when no brief has been written yet. */
  brief: {
    standing: string | null;
    nextStep: string | null;
    generatedAt: Date;
    /** Null when the deterministic no-model fallback wrote it. */
    model: string | null;
    recentDiscussions: RecentDiscussion[];
  } | null;
  goals: {
    /** How many active goals the user has. Zero means "add one", not "nothing fits". */
    activeCount: number;
    /** Only goals that are still active, in the user's newest-first order. */
    fits: DossierGoalFit[];
    /** Whether the brief was ever judged against goals (an empty `fits` is then meaningful). */
    judged: boolean;
  };
  facts: {
    tags: string[];
    career: string | null;
    recentMoves: string | null;
    events: EventTogether[];
  };
  /** An interaction is newer than the brief. Regenerating helps with or without an AI key. */
  stale: boolean;
  /**
   * A goal was added since the fit was judged. Regenerating only helps when AI can run, so
   * the pane checks that before it starts one; without a key this would stay true forever.
   */
  goalsUnjudged: boolean;
};

/**
 * Everything the dossier reads about one person, scoped to `userId`.
 *
 * Returns null for a contact that is not the caller's, before anything else is read into a
 * payload. Every side read is guarded on its own, because a dossier missing its events is
 * a better page than a dossier that failed to open. Related people are NOT here: they come
 * from `listRelatedContacts` (a server action that takes the session itself), and the pane
 * calls it alongside this so the two reads run together.
 *
 * Read-only by design (the Knowledge page is for understanding; editing lives on the
 * contact's own page), and it reads no `notes`, no photo and no full interaction history —
 * the brief's `recentDiscussions` already carries the recent thread, one line each.
 */
export async function loadKnowledgeDossier(
  userId: string,
  contactId: string
): Promise<KnowledgeDossier | null> {
  const db = await getDb();

  const [row] = await db
    .select({
      id: contacts.id,
      fullName: contacts.fullName,
      preferredName: contacts.preferredName,
      firstName: contacts.firstName,
      title: contacts.title,
      company: contacts.company,
      location: contacts.location,
      closenessTier: contacts.closenessTier,
      lastInteractionAt: contacts.lastInteractionAt,
      aiSummary: contacts.aiSummary,
      keyFacts: contacts.keyFacts,
      howMet: contacts.howMet,
      metContext: contacts.metContext,
      dateMet: contacts.dateMet,
      hasPhoto: sql<boolean>`(${contacts.profileImageUrl} IS NOT NULL AND ${contacts.profileImageUrl} <> '')`,
    })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)))
    .limit(1);
  if (!row) return null;

  const [brief, goals, tagRows, careerLines, moveLines, events] = await Promise.all([
    getContactBrief(userId, contactId).catch(() => null),
    listActiveGoalsForUser(userId).catch(() => []),
    db
      .select({ name: tags.name })
      .from(contactTags)
      .innerJoin(tags, eq(tags.id, contactTags.tagId))
      .where(and(eq(contactTags.contactId, contactId), eq(tags.userId, userId)))
      .catch(() => []),
    getCareerLines(userId, [contactId]).catch(() => new Map<string, string>()),
    getRecentMoveLines(userId, [contactId]).catch(() => new Map<string, string>()),
    listEventsTogetherForContact(userId, contactId, 8).catch(() => []),
  ]);

  const goalById = new Map(goals.map((g) => [g.id, g.text]));
  // Items for a goal that has since been deleted are dropped here, not by a regeneration.
  const fits: DossierGoalFit[] = (brief?.goalFit?.items ?? []).flatMap((item) => {
    const goalText = goalById.get(item.goalId);
    return goalText ? [{ goalId: item.goalId, goalText, why: item.why }] : [];
  });

  return {
    contact: {
      id: row.id,
      fullName: row.fullName,
      preferredName: row.preferredName,
      firstName: row.firstName,
      title: row.title,
      company: row.company,
      location: row.location,
      hasPhoto: Boolean(row.hasPhoto),
      closenessTier: row.closenessTier ?? null,
      lastInteractionAt: row.lastInteractionAt,
      aiSummary: row.aiSummary,
      keyFacts: Array.isArray(row.keyFacts) ? row.keyFacts.filter((f): f is string => typeof f === "string") : [],
      howMet:
        formatHowMetSummary({ metContext: row.metContext, dateMet: row.dateMet, howMet: row.howMet }) || null,
    },
    brief: brief
      ? {
          standing: brief.standing,
          nextStep: brief.nextStep,
          generatedAt: brief.generatedAt,
          model: brief.model,
          recentDiscussions: brief.recentDiscussions,
        }
      : null,
    goals: {
      activeCount: goals.length,
      fits,
      judged: brief?.goalFit != null,
    },
    facts: {
      tags: tagRows.map((t) => t.name),
      career: careerLines.get(contactId) ?? null,
      recentMoves: moveLines.get(contactId) ?? null,
      events,
    },
    stale: isBriefStale(brief, row.lastInteractionAt),
    goalsUnjudged: goalFitOutOfDate(goals, brief?.goalFit ?? null),
  };
}
