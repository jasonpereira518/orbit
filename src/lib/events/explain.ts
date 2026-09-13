/**
 * The optional AI line: why this person, and what to open with.
 *
 * ## What it is, and what it is not
 *
 * It is NOT the recommender. `scoreAttendee` already decided who is worth finding, from
 * facts, deterministically, with reasons a person can read. This writes one sentence about a
 * row that has already been chosen — and it can be switched off entirely without the feature
 * losing its point.
 *
 * That order matters. A model asked to rank a roster gives a different answer on Tuesday than
 * it did on Monday for the same data, and a ranking that reshuffles under you is one you stop
 * trusting. A model asked "say this in one sentence" cannot reshuffle anything.
 *
 * ## What it is given
 *
 * The roster row's own fields and the reasons the score already produced. Not the user's
 * notes, not their mail, not anything discovery recorded about where an event came from. The
 * prompt is small on purpose: it is cheaper, and a prompt that cannot see private data cannot
 * leak it.
 *
 * Cached on the attendee row under a hash of exactly those inputs, so it regenerates when the
 * facts change and never on a re-render.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { completeJson } from "@/lib/ai";
import { companyMatchKeys } from "@/lib/events/company-list-parse";
import { loadTargetKeys } from "@/lib/events/companies";
import { eventsTogetherForRoster } from "@/lib/events/people-store";
import { listSchools } from "@/lib/events/target-companies";
import { listActiveGoalTextsForUser } from "@/lib/user-goals";
import { goalRelevanceComponent } from "@/lib/closeness";
import { eventKindOf } from "@/lib/events/company-list-parse";
import { scoreAttendee } from "@/lib/events/relevance";

export type AiNote = {
  why: string;
  opener: string;
  inputsHash: string;
  generatedAt: string;
};

function hashInputs(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

const SYSTEM = [
  "You help someone decide who to talk to at an event they are attending.",
  "You are given one attendee and the factual reasons they were shortlisted.",
  "Write from those reasons only. Never invent a shared interest, a mutual contact,",
  "a job history, or anything else you were not given.",
  'Reply as {"why": string, "opener": string}.',
  '"why" is one sentence, under 20 words, plain and specific.',
  '"opener" is one sentence someone could actually say out loud — no flattery, no pitch,',
  "no exclamation marks, and never a question about something you were not told.",
].join(" ");

export async function explainAttendeeForUser(
  userId: string,
  eventId: string,
  attendeeId: string
): Promise<{ ok: boolean; why?: string; opener?: string; error?: string }> {
  const db = await getDb();

  const rows = rowsOf<{
    id: string;
    full_name: string | null;
    company: string | null;
    title: string | null;
    attendee_role: "attendee" | "host" | "speaker" | null;
    contact_id: string | null;
    ai_note: AiNote | null;
    event_title: string;
    event_kind: string | null;
    event_description: string | null;
    event_organizer: string | null;
    closeness_tier: "inner" | "mid" | "outer" | null;
    last_interaction_at: string | Date | null;
    contact_school: string | null;
  }>(
    await db.execute(sql`
      SELECT a.id, a.full_name, a.company, a.title, a.attendee_role, a.contact_id, a.ai_note,
             e.title AS event_title, e.kind AS event_kind, e.description AS event_description,
             e.organizer_name AS event_organizer,
             c.closeness_tier, c.last_interaction_at, c.school AS contact_school
        FROM event_attendees a
        JOIN events e ON e.id = a.event_id AND e.user_id = a.user_id
        LEFT JOIN contacts c ON c.id = a.contact_id AND c.user_id = a.user_id
       WHERE a.user_id = ${userId} AND a.id = ${attendeeId} AND a.event_id = ${eventId}
       LIMIT 1
    `)
  );

  const row = rows[0];
  if (!row) return { ok: false, error: "That person is no longer on this roster." };

  const [goals, targetKeys, history, userSchools] = await Promise.all([
    listActiveGoalTextsForUser(userId),
    loadTargetKeys(userId),
    eventsTogetherForRoster(userId, eventId),
    listSchools(userId),
  ]);

  const scored = scoreAttendee({
    fullName: row.full_name,
    company: row.company,
    title: row.title,
    attendeeRole: row.attendee_role,
    connectedHere: row.contact_id !== null,
    companyKeys: companyMatchKeys(row.company),
    targetKeys,
    goalFit: goalRelevanceComponent(
      { company: row.company, title: row.title } as Parameters<
        typeof goalRelevanceComponent
      >[0],
      goals
    ),
    eventsTogether: history.get(row.id)?.count ?? 1,
    network: row.contact_id
      ? {
          contactId: row.contact_id,
          closenessTier: row.closeness_tier,
          lastInteractionAt: row.last_interaction_at ? new Date(row.last_interaction_at) : null,
          schools: row.contact_school ? [row.contact_school] : [],
        }
      : null,
    knownAtCompany: 0,
    userSchools,
    eventKind:
      (row.event_kind as ReturnType<typeof eventKindOf>) ??
      eventKindOf({ title: row.event_title, description: row.event_description, organizerName: row.event_organizer }),
  });

  // Exactly what the model will see. A change to any of it invalidates the cache; a
  // re-render of the same facts does not.
  const inputs = {
    name: row.full_name,
    company: row.company,
    title: row.title,
    role: row.attendee_role,
    event: row.event_title,
    reasons: scored.reasons.map((reason) => reason.label),
  };
  const inputsHash = hashInputs([inputs]);

  if (row.ai_note?.inputsHash === inputsHash) {
    return { ok: true, why: row.ai_note.why, opener: row.ai_note.opener };
  }
  if (scored.reasons.length === 0) {
    return { ok: false, error: "There's nothing specific to say about them yet." };
  }

  let parsed: { why?: unknown; opener?: unknown };
  try {
    const raw = await completeJson(userId, {
      system: SYSTEM,
      user: JSON.stringify(inputs),
      operation: "events.why",
      speed: "fast",
      maxOutputTokens: 300,
    });
    parsed = JSON.parse(raw) as { why?: unknown; opener?: unknown };
  } catch {
    return { ok: false, error: "Couldn't write that just now — try again?" };
  }

  const why = typeof parsed.why === "string" ? parsed.why.trim().slice(0, 200) : "";
  const opener = typeof parsed.opener === "string" ? parsed.opener.trim().slice(0, 300) : "";
  if (!why && !opener) return { ok: false, error: "Couldn't write that just now — try again?" };

  const note: AiNote = {
    why,
    opener,
    inputsHash,
    generatedAt: new Date().toISOString(),
  };
  await db.execute(sql`
    UPDATE event_attendees SET ai_note = ${JSON.stringify(note)}::jsonb, updated_at = now()
     WHERE id = ${attendeeId} AND user_id = ${userId}
  `);

  return { ok: true, why, opener };
}
