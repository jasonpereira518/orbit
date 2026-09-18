/**
 * Ranking one event's roster.
 *
 * Gathers everything `scoreAttendee` needs in a handful of batched reads and then scores in
 * JavaScript. Deliberately not SQL: the weights change as the feature is tuned, and a scoring
 * expression spread across a query is one nobody can read, test in isolation, or explain to
 * the user afterwards.
 *
 * ## Before, or after
 *
 * The same ranking answers two different questions depending on when you ask it. Before an
 * event it is "who should I find" — a plan. Afterwards it is "who should I follow up with" —
 * a list of the people worth the effort, with the ones already handled dropped to the bottom.
 * The caller passes the event; this decides which question it is from the date.
 */
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { goalRelevanceComponent } from "@/lib/closeness";
import { listActiveGoalTextsForUser } from "@/lib/user-goals";
import { companyMatchKeys, eventKindOf } from "@/lib/events/company-list-parse";
import { loadTargetKeys } from "@/lib/events/companies";
import { eventsTogetherForRoster } from "@/lib/events/people-store";
import { listSchools } from "@/lib/events/target-companies";
import { scoreAttendee, type RelevanceReason } from "@/lib/events/relevance";
import type { EventRecord } from "@/db/schema";

export type WhoToTalkToRow = {
  attendeeId: string;
  name: string;
  company: string | null;
  title: string | null;
  contactId: string | null;
  score: number;
  bucket: "must" | "good" | "maybe" | "skip";
  reasons: RelevanceReason[];
};

export type WhoToTalkTo = {
  /** `upcoming` changes the copy from "follow up" to "find", and nothing else. */
  when: "upcoming" | "past";
  rows: WhoToTalkToRow[];
};

/** Everything the score needs about one roster row, in one read. */
type RosterRow = {
  id: string;
  full_name: string | null;
  company: string | null;
  title: string | null;
  attendee_role: "attendee" | "host" | "speaker" | null;
  contact_id: string | null;
  /** From the contact this row resolves to, directly or through `contact_identities`. */
  matched_contact_id: string | null;
  closeness_tier: "inner" | "mid" | "outer" | null;
  last_interaction_at: string | Date | null;
  contact_company: string | null;
  contact_title: string | null;
  contact_notes: string | null;
  contact_industry: string | null;
  schools: string | null;
};

export async function whoToTalkTo(
  userId: string,
  event: EventRecord,
  options: { limit?: number } = {}
): Promise<WhoToTalkTo> {
  const limit = options.limit ?? 5;
  const db = await getDb();

  const [roster, goals, targetKeys, history, userSchools] = await Promise.all([
    db
      .execute(
        sql`
          SELECT a.id, a.full_name, a.company, a.title, a.attendee_role, a.contact_id,
                 COALESCE(a.contact_id, ci.contact_id) AS matched_contact_id,
                 c.closeness_tier, c.last_interaction_at,
                 c.company AS contact_company, c.title AS contact_title,
                 c.notes AS contact_notes, c.industry AS contact_industry,
                 c.school AS schools
            FROM event_attendees a
            -- The same join "people you keep seeing" uses: a roster row resolves to a known
            -- contact through contact_identities long before anybody presses connect.
            LEFT JOIN contact_identities ci
              ON ci.user_id = a.user_id
             AND ci.kind = a.person_key_kind
             AND ci.value = a.person_key_value
            LEFT JOIN contacts c
              ON c.id = COALESCE(a.contact_id, ci.contact_id) AND c.user_id = a.user_id
           WHERE a.user_id = ${userId} AND a.event_id = ${event.id}
           LIMIT 2000
        `
      )
      .then((result) => rowsOf<RosterRow>(result)),
    listActiveGoalTextsForUser(userId),
    loadTargetKeys(userId),
    eventsTogetherForRoster(userId, event.id),
    listSchools(userId),
  ]);

  if (roster.length === 0) {
    return { when: eventIsUpcoming(event) ? "upcoming" : "past", rows: [] };
  }

  // How many contacts the user has at each employer on this roster — the "warm path" signal,
  // in one grouped read rather than one per row.
  const knownAtCompany = await contactsPerCompany(
    userId,
    roster.flatMap((row) => companyMatchKeys(row.company))
  );

  const kind = event.kind ?? eventKindOf(event);
  const rows: WhoToTalkToRow[] = roster.map((row) => {
    const keys = companyMatchKeys(row.company);
    const result = scoreAttendee({
      fullName: row.full_name,
      company: row.company ?? row.contact_company,
      title: row.title ?? row.contact_title,
      attendeeRole: row.attendee_role,
      connectedHere: row.contact_id !== null,
      companyKeys: keys,
      targetKeys,
      goalFit: goalRelevanceComponent(
        {
          company: row.company ?? row.contact_company,
          title: row.title ?? row.contact_title,
          industry: row.contact_industry,
          notes: row.contact_notes,
        } as Parameters<typeof goalRelevanceComponent>[0],
        goals
      ),
      eventsTogether: history.get(row.id)?.count ?? 1,
      network: row.matched_contact_id
        ? {
            contactId: row.matched_contact_id,
            closenessTier: row.closeness_tier,
            lastInteractionAt: row.last_interaction_at
              ? new Date(row.last_interaction_at)
              : null,
            schools: row.schools ? [row.schools] : [],
          }
        : null,
      knownAtCompany: keys.reduce((max, key) => Math.max(max, knownAtCompany.get(key) ?? 0), 0),
      userSchools,
      eventKind: kind,
    });

    return {
      attendeeId: row.id,
      name: row.full_name ?? "Someone",
      company: row.company ?? row.contact_company,
      title: row.title ?? row.contact_title,
      contactId: row.matched_contact_id,
      score: result.score,
      bucket: result.bucket,
      reasons: result.reasons,
    };
  });

  return {
    when: eventIsUpcoming(event) ? "upcoming" : "past",
    rows: rows
      // Nothing worth saying about them is worse than nothing: a row with no reasons is
      // padding, and padding is what makes a recommendation panel ignorable.
      .filter((row) => row.reasons.length > 0 && row.bucket !== "skip")
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, limit),
  };
}

function eventIsUpcoming(event: EventRecord): boolean {
  const start = event.startsAt ? new Date(event.startsAt).getTime() : null;
  if (start === null) return false;
  // Generous: an event is "upcoming" until the end of its day, so the plan is still there
  // on the morning of, which is when people actually look at it.
  return start + 86_400_000 > Date.now();
}

async function contactsPerCompany(
  userId: string,
  keys: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Set(keys.filter(Boolean))];
  if (unique.length === 0) return out;
  const db = await getDb();

  const rows = rowsOf<{ key: string; n: string | number }>(
    await db.execute(sql`
      SELECT trim(${sql.raw("regexp_replace(regexp_replace(lower(company), '[^a-z0-9\\s]', ' ', 'g'), '\\s+', ' ', 'g')")}) AS key,
             COUNT(*) AS n
        FROM contacts
       WHERE user_id = ${userId}
         AND company IS NOT NULL
         AND trim(${sql.raw("regexp_replace(regexp_replace(lower(company), '[^a-z0-9\\s]', ' ', 'g'), '\\s+', ' ', 'g')")})
             IN (${sql.join(
               unique.map((key) => sql`${key}`),
               sql`, `
             )})
       GROUP BY 1
    `)
  );
  for (const row of rows) out.set(row.key, Number(row.n));
  return out;
}
