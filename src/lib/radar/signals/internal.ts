/**
 * Everything Radar knows about the network before it looks outside it, in a handful of
 * batched reads.
 *
 * Every query here is scoped to one account and bounded by a time window, so none of them
 * needs a list of contact ids and none of them grows with the size of the network: a
 * 10,000-contact account issues the same statements as a 50-contact one. The scorer
 * (`src/lib/radar/score.ts`) owns every timing rule; these queries only pre-filter loosely
 * so the rows that come back are the ones worth scoring.
 *
 * `contacts.notes` and `interactions.raw_notes` are never selected (docs/performance.md).
 */
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { EVIDENCE_FLOOR } from "@/lib/closeness-evidence";
import { attendedEventFilter } from "@/lib/events/store";
import { AI_DERIVED_SOURCE } from "@/lib/interaction-provenance";
import { JOB_SIGNAL_SUGGESTION_TYPE } from "@/lib/jobs/matcher";
import { ENCOUNTER_TYPES, metContactSql } from "@/lib/met-contact";
import { jobChangeSentence } from "@/lib/contact-profile-format";
import { isCongratsWorthy } from "@/lib/job-changes";
import { OPEN_OPPORTUNITY_STATUSES } from "@/lib/opportunity-kinds";
import { LINKEDIN_QUIET_MAX_DAYS } from "@/lib/outreach-thresholds";
import { RADAR_WINDOWS, type RadarTier } from "@/lib/radar/score";
import type { RadarSignal } from "@/lib/radar/types";
import type { RelationshipOpenThread } from "@/db/schema";

const DAY_MS = 86_400_000;

/** The most people one run will score. Far above any plausible "worth a message" set. */
export const RADAR_CANDIDATE_CAP = 1500;

/** How far ahead a meeting or event makes someone worth preparing for. */
const PREP_AHEAD_DAYS = RADAR_WINDOWS.prepAhead;
/** How recently an event must have ended to still be a reason to follow up. */
const POST_EVENT_DAYS = 14;
/** Action items older than this are archaeology, not a loop to close. */
const ACTION_ITEM_MAX_DAYS = 180;
/** How overdue an opportunity can be and still be worth raising. */
const OPPORTUNITY_OVERDUE_DAYS = 30;
/** A brief's next step older than this is likely stale. */
const BRIEF_MAX_DAYS = 60;

function daysBefore(now: Date, days: number) {
  return new Date(now.getTime() - days * DAY_MS);
}
function daysAfter(now: Date, days: number) {
  return new Date(now.getTime() + days * DAY_MS);
}
function asDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function produceInternalSignals(userId: string, now: Date): Promise<RadarSignal[]> {
  const db = await getDb();
  const [messages, meetings, events, items, opportunities, briefs, jobs, moves, threads, encounters] = await Promise.all([
    // LinkedIn threads, one row per contact whose latest message is in the window. Direction
    // is only ever set on linkedin_message rows, which is what separates "they are waiting
    // on you" from "the thread went quiet".
    db.execute(sql`
      SELECT contact_id,
             count(*)::int AS n,
             max(interaction_date) AS last_at,
             max(interaction_date) FILTER (WHERE direction = 'in') AS last_in,
             max(interaction_date) FILTER (WHERE direction = 'out') AS last_out,
             (array_agg(id ORDER BY interaction_date DESC))[1] AS last_id
        FROM interactions
       WHERE user_id = ${userId}
         AND interaction_type = 'linkedin_message'
         AND (source IS NULL OR source <> ${AI_DERIVED_SOURCE})
       GROUP BY contact_id
      HAVING max(interaction_date) >= ${daysBefore(now, LINKEDIN_QUIET_MAX_DAYS)}
         AND max(interaction_date) <= ${daysBefore(now, RADAR_WINDOWS.inboundMin)}
    `),
    // The soonest meeting ahead per contact. Calendar sync writes these up to 60 days out.
    db.execute(sql`
      SELECT DISTINCT ON (contact_id) id, contact_id, interaction_date AS at, left(ai_summary, 120) AS title
        FROM interactions
       WHERE user_id = ${userId}
         AND interaction_type = 'meeting'
         AND interaction_date > ${now}
         AND interaction_date <= ${daysAfter(now, PREP_AHEAD_DAYS)}
       ORDER BY contact_id, interaction_date ASC
    `),
    // Events the user attended or will attend, with the contacts linked to their rosters.
    db.execute(sql`
      SELECT e.id, a.contact_id, e.title, e.starts_at, e.ends_at
        FROM events e
        JOIN event_attendees a ON a.event_id = e.id AND a.user_id = e.user_id
       WHERE e.user_id = ${userId}
         AND a.contact_id IS NOT NULL
         AND ${attendedEventFilter()}
         AND e.starts_at >= ${daysBefore(now, POST_EVENT_DAYS)}
         AND e.starts_at <= ${daysAfter(now, PREP_AHEAD_DAYS)}
    `),
    // Open action items per contact: how many, the oldest, and what the oldest says.
    db.execute(sql`
      SELECT contact_id,
             count(*)::int AS n,
             min(created_at) AS oldest,
             (array_agg(left(text, 160) ORDER BY created_at ASC))[1] AS first_text,
             (array_agg(id ORDER BY created_at ASC))[1] AS first_id
        FROM action_items
       WHERE user_id = ${userId}
         AND status = 'open'
         -- Something the person owes. An item they are waiting on from the other side is not
         -- a loop for them to close.
         AND owed_by IS DISTINCT FROM 'them'
         AND created_at >= ${daysBefore(now, ACTION_ITEM_MAX_DAYS)}
       GROUP BY contact_id
    `),
    // The most pressing open opportunity per contact with a due date near now.
    db.execute(sql`
      SELECT DISTINCT ON (contact_id) id, contact_id, left(label, 160) AS label, due_date
        FROM contact_opportunities
       WHERE user_id = ${userId}
         AND status IN (${sql.join(OPEN_OPPORTUNITY_STATUSES.map((status) => sql`${status}`), sql`, `)})
         AND due_date IS NOT NULL
         AND due_date >= ${daysBefore(now, OPPORTUNITY_OVERDUE_DAYS)}
         AND due_date <= ${daysAfter(now, PREP_AHEAD_DAYS)}
       ORDER BY contact_id, due_date ASC
    `),
    // The one next step each recent brief distilled.
    db.execute(sql`
      SELECT contact_id, left(next_step, 160) AS next_step, generated_at
        FROM contact_briefs
       WHERE user_id = ${userId}
         AND next_step IS NOT NULL
         AND generated_at >= ${daysBefore(now, BRIEF_MAX_DAYS)}
    `),
    // Job-feed matches the hourly sweep already wrote. Read, never re-derived.
    db.execute(sql`
      SELECT id, related_contact_ids ->> 0 AS contact_id, coalesce(description, title) AS text, created_at
        FROM ai_suggestions
       WHERE user_id = ${userId}
         AND status = 'pending'
         AND suggestion_type = ${JOB_SIGNAL_SUGGESTION_TYPE}
    `),
    // Job moves the work-history check logged (`recordJobChanges`, lib/job-changes.ts): the
    // newest per contact in the window. Read, never re-derived, and already sanitized there.
    db.execute(sql`
      SELECT DISTINCT ON (contact_id) id, contact_id, kind, from_org, from_title, to_org, to_title,
             started_year, started_month, detected_at
        FROM contact_career_moves
       WHERE user_id = ${userId}
         AND detected_at >= ${daysBefore(now, RADAR_WINDOWS.jobChangeMax)}
       ORDER BY contact_id, detected_at DESC
    `),
    // Loops in their messages the person owes a reply on, distilled by the relationship engine.
    // Only digests with at least one such thread come back.
    db.execute(sql`
      SELECT contact_id, open_threads
        FROM relationship_digests
       WHERE user_id = ${userId}
         AND open_threads @> '[{"owedBy":"me"}]'::jsonb
    `),
    // The latest real encounter per contact (a meeting, call, coffee, event) in the follow-up
    // window. The scorer decides whether it was followed up.
    db.execute(sql`
      SELECT DISTINCT ON (contact_id) id, contact_id, interaction_date AS at
        FROM interactions
       WHERE user_id = ${userId}
         AND interaction_type IN (${sql.join(ENCOUNTER_TYPES.map((t) => sql`${t}`), sql`, `)})
         AND interaction_date <= ${now}
         AND interaction_date >= ${daysBefore(now, RADAR_WINDOWS.metRecentlyMax)}
         AND (source IS NULL OR source <> ${AI_DERIVED_SOURCE})
       ORDER BY contact_id, interaction_date DESC
    `),
  ]);

  const out: RadarSignal[] = [];

  for (const r of rowsOf<{ contact_id: string; n: number; last_at: string | Date; last_in: string | Date | null; last_out: string | Date | null; last_id: string }>(messages)) {
    const source = { table: "interactions" as const, id: r.last_id };
    const lastAt = asDate(r.last_at);
    const lastIn = asDate(r.last_in);
    const lastOut = asDate(r.last_out);
    if (!lastAt) continue;
    const theyWroteLast = lastIn !== null && lastIn.getTime() === lastAt.getTime() && (!lastOut || lastOut < lastIn);
    if (theyWroteLast) out.push({ kind: "inbound_unanswered", contactId: r.contact_id, at: lastIn, source });
    else out.push({ kind: "linkedin_thread_quiet", contactId: r.contact_id, at: lastAt, count: Number(r.n), source });
  }

  for (const r of rowsOf<{ id: string; contact_id: string; at: string | Date; title: string | null }>(meetings)) {
    const at = asDate(r.at);
    if (at) out.push({ kind: "upcoming_meeting", contactId: r.contact_id, at, title: r.title?.trim() || null, source: { table: "interactions", id: r.id } });
  }

  // One upcoming and one past event per contact: the soonest ahead, the latest behind.
  const upcoming = new Map<string, { at: Date; title: string; id: string }>();
  const past = new Map<string, { at: Date; title: string; id: string }>();
  for (const r of rowsOf<{ id: string; contact_id: string; title: string; starts_at: string | Date; ends_at: string | Date | null }>(events)) {
    const start = asDate(r.starts_at);
    if (!start) continue;
    const end = asDate(r.ends_at) ?? start;
    if (start > now) {
      const seen = upcoming.get(r.contact_id);
      if (!seen || start < seen.at) upcoming.set(r.contact_id, { at: start, title: r.title, id: r.id });
    } else if (end < now) {
      const seen = past.get(r.contact_id);
      if (!seen || end > seen.at) past.set(r.contact_id, { at: end, title: r.title, id: r.id });
    }
  }
  for (const [contactId, e] of upcoming) out.push({ kind: "event_upcoming", contactId, at: e.at, title: e.title, source: { table: "events", id: e.id } });
  for (const [contactId, e] of past) out.push({ kind: "post_event", contactId, at: e.at, title: e.title, source: { table: "events", id: e.id } });

  for (const r of rowsOf<{ contact_id: string; n: number; oldest: string | Date; first_text: string; first_id: string }>(items)) {
    const at = asDate(r.oldest);
    if (at) {
      out.push({
        kind: "action_item_open",
        contactId: r.contact_id,
        at,
        text: r.first_text,
        count: Number(r.n),
        source: { table: "action_items", id: r.first_id, text: r.first_text, quote: r.first_text },
      });
    }
  }

  for (const r of rowsOf<{ id: string; contact_id: string; label: string; due_date: string | Date }>(opportunities)) {
    const at = asDate(r.due_date);
    if (at) out.push({ kind: "opportunity_due", contactId: r.contact_id, at, label: r.label, source: { table: "contact_opportunities", id: r.id, text: r.label, quote: r.label } });
  }

  for (const r of rowsOf<{ contact_id: string; next_step: string; generated_at: string | Date }>(briefs)) {
    out.push({ kind: "brief_next_step", contactId: r.contact_id, at: asDate(r.generated_at), text: r.next_step });
  }

  const jobSeen = new Set<string>();
  for (const r of rowsOf<{ id: string; contact_id: string | null; text: string | null; created_at: string | Date }>(jobs)) {
    const at = asDate(r.created_at);
    if (!r.contact_id || !r.text || !at || jobSeen.has(r.contact_id)) continue;
    jobSeen.add(r.contact_id);
    out.push({ kind: "job_posting", contactId: r.contact_id, at, text: r.text, source: { table: "ai_suggestions", id: r.id, text: r.text, quote: r.text } });
  }

  for (const r of rowsOf<{
    id: string;
    contact_id: string;
    kind: "joined" | "left" | "title_change";
    from_org: string | null;
    from_title: string | null;
    to_org: string | null;
    to_title: string | null;
    started_year: number | null;
    started_month: number | null;
    detected_at: string | Date;
  }>(moves)) {
    const at = asDate(r.detected_at);
    if (!at) continue;
    // A new role that began long before the check found it is history, not news: no card
    // that reads as "just joined". A departure stays a plain heads-up.
    if (r.kind !== "left" && !isCongratsWorthy({ kind: r.kind, startedYear: r.started_year, startedMonth: r.started_month }, now)) continue;
    const text = jobChangeSentence({
      kind: r.kind,
      fromOrg: r.from_org,
      fromTitle: r.from_title,
      toOrg: r.to_org,
      toTitle: r.to_title,
    }).slice(0, 200);
    out.push({ kind: "job_change", contactId: r.contact_id, at, move: r.kind, text, source: { table: "contact_career_moves", id: r.id } });
  }

  // The newest open thread the person owes, per contact. Quoted from the digest row, so the
  // card's line is checkable against it.
  // A digest row is keyed by its contact (one per person), so the proof names it by contact id.
  for (const r of rowsOf<{ contact_id: string; open_threads: RelationshipOpenThread[] | string }>(threads)) {
    const all = typeof r.open_threads === "string" ? (JSON.parse(r.open_threads) as RelationshipOpenThread[]) : r.open_threads;
    const owed = (Array.isArray(all) ? all : [])
      .filter((t) => t.owedBy === "me" && typeof t.text === "string" && t.text.trim())
      .sort((a, b) => b.sinceIso.localeCompare(a.sinceIso))[0];
    const at = owed ? asDate(owed.sinceIso) : null;
    if (!owed || !at) continue;
    const text = owed.text.trim().slice(0, 160);
    out.push({ kind: "open_thread", contactId: r.contact_id, at, text, source: { table: "relationship_digests", id: r.contact_id, text: owed.text, quote: text } });
  }

  for (const r of rowsOf<{ id: string; contact_id: string; at: string | Date }>(encounters)) {
    const at = asDate(r.at);
    if (at) out.push({ kind: "met_recently", contactId: r.contact_id, at, source: { table: "interactions", id: r.id } });
  }

  return out;
}

/** One contact as the run needs it: the scorer's inputs plus what the card displays. */
export type RadarCandidateRow = {
  id: string;
  fullName: string;
  preferredName: string | null;
  title: string | null;
  company: string | null;
  industry: string | null;
  email?: string | null;
  tier: RadarTier | null;
  hasEvidence: boolean;
  priorityLevel: number;
  relationshipScore: number;
  statedCloseness: number | null;
  firstInteractionAt: Date | null;
  lastInteractionAt: Date | null;
  nextFollowUpAt: Date | null;
  constellationPin: "in" | "out" | null;
  cadenceDays: number | null;
  cadencePhrase: string | null;
};

/**
 * The people worth scoring: everyone a signal names, plus everyone valuable enough that
 * silence alone might matter. Always and only people the user has met or talked with
 * (`met-contact.ts`). One statement. People a signal names sort first, so the cap can never
 * drop a meeting for a dormant tie.
 */
export async function loadCandidates(userId: string, signalContactIds: readonly string[]): Promise<RadarCandidateRow[]> {
  const db = await getDb();
  const ids = [...new Set(signalContactIds)].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const idArray = ids.length
    ? sql`ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]::uuid[]`
    : sql`ARRAY[]::uuid[]`;
  const rows = rowsOf<{
    id: string;
    full_name: string;
    preferred_name: string | null;
    title: string | null;
    company: string | null;
    industry: string | null;
    email: string | null;
    closeness_tier: RadarTier | null;
    closeness_evidence: number | null;
    priority_level: number;
    relationship_score: number;
    stated_closeness: number | null;
    first_interaction_at: string | Date | null;
    last_interaction_at: string | Date | null;
    next_follow_up_at: string | Date | null;
    constellation_pin: "in" | "out" | null;
    cadence_days: number | null;
    cadence_phrase: string | null;
  }>(
    await db.execute(sql`
      SELECT id, full_name, preferred_name, title, company, industry, email, closeness_tier, closeness_evidence,
             priority_level, relationship_score, stated_closeness, first_interaction_at,
             last_interaction_at, next_follow_up_at, constellation_pin, cadence_days, cadence_phrase
        FROM contacts
       WHERE user_id = ${userId}
         AND constellation_pin IS DISTINCT FROM 'out'
         -- Only people the user has met or talked with (met-contact.ts): a card is an alert.
         AND ${metContactSql(sql`contacts.id`, userId)}
         AND (
           id = ANY(${idArray})
           -- Silence alone is a reason only for someone with a stated rhythm or an inner-circle
           -- tie with real evidence (the scorer's dormancy rule); everyone else needs a signal.
           OR cadence_days IS NOT NULL
           OR (closeness_tier = 'inner' AND closeness_evidence >= ${EVIDENCE_FLOOR})
         )
       ORDER BY (id = ANY(${idArray})) DESC, closeness DESC NULLS LAST, id
       LIMIT ${RADAR_CANDIDATE_CAP}
    `)
  );
  return rows.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    preferredName: r.preferred_name,
    title: r.title,
    company: r.company,
    industry: r.industry,
    email: r.email,
    tier: r.closeness_tier,
    hasEvidence: (r.closeness_evidence ?? 0) >= EVIDENCE_FLOOR,
    priorityLevel: Number(r.priority_level ?? 0),
    relationshipScore: Number(r.relationship_score ?? 2),
    statedCloseness: r.stated_closeness === null ? null : Number(r.stated_closeness),
    firstInteractionAt: asDate(r.first_interaction_at),
    lastInteractionAt: asDate(r.last_interaction_at),
    nextFollowUpAt: asDate(r.next_follow_up_at),
    constellationPin: r.constellation_pin,
    cadenceDays: r.cadence_days === null ? null : Number(r.cadence_days),
    cadencePhrase: r.cadence_phrase,
  }));
}
