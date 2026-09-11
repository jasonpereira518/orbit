/**
 * The people who keep turning up.
 *
 * The single most useful thing a networking tracker can notice about events, and the reason
 * rosters are worth keeping at all: somebody you have now shared four rooms with and never
 * spoken to is a far better introduction than a stranger, and nobody remembers that on their
 * own.
 *
 * ## Computed on demand, not materialised
 *
 * The obvious design is a `event_people` table kept in step by triggers or a backfill. This
 * does not do that, for three reasons:
 *
 *   - It is always right. A corrected name, a merged contact, a dismissed event and a deleted
 *     roster row all change the answer, and a materialised table would need every one of
 *     those paths to remember to update it. They will not.
 *   - The scale is small. One user's whole roster history is thousands of rows, and
 *     `event_attendees_person_idx` covers the grouping.
 *   - It has no write path to get wrong. The aggregate reads; nothing here can corrupt.
 *
 * Revisit only if `smoke-page-budgets` says otherwise.
 *
 * ## What counts as "the same person"
 *
 * A contact id when the row has been connected — the user's own answer, and the best one. A
 * contact id reached through `contact_identities` when it has not: that table's unique index
 * on `(user_id, kind, value)` is exactly the join, which is why `personKeyOf` uses its kind
 * names. Otherwise the person key itself.
 *
 * Name-tier clusters are marked `weak` and excluded by default. Two different David Kims at
 * two meetups are not a pattern, and saying they are is worse than saying nothing.
 */
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { personKeyOf, type PersonKeyKind } from "@/lib/events/people";

export type RepeatPerson = {
  /** Stable per cluster, for React keys and for linking through to a filtered view. */
  clusterKey: string;
  contactId: string | null;
  name: string | null;
  company: string | null;
  title: string | null;
  linkedinUrl: string | null;
  eventsTogether: number;
  lastTogetherAt: Date | null;
  /** Whether any roster row for them has been connected to a contact. */
  connected: boolean;
  /** True when the only thing linking these appearances is a name. Shown differently. */
  weak: boolean;
};

/**
 * The cluster expression, shared by every query here.
 *
 * `c:<id>` for anyone resolved to a contact, so a person connected at one event and merely
 * listed at another counts once. Otherwise `<kind>:<value>`.
 */
const CLUSTER = sql`
  COALESCE(
    'c:' || COALESCE(a.contact_id::text, ci.contact_id::text),
    a.person_key_kind || ':' || a.person_key_value
  )
`;

/**
 * The join that lets an unconnected roster row still resolve to a known contact.
 *
 * `contact_identities` holds `(kind, value)` per contact under a unique index, and
 * `personKeyOf` emits those same kind names precisely so this join is possible without a
 * second implementation of "is this the same person".
 */
const IDENTITY_JOIN = sql`
  LEFT JOIN contact_identities ci
    ON ci.user_id = a.user_id
   AND ci.kind = a.person_key_kind
   AND ci.value = a.person_key_value
`;

export type RepeatOptions = {
  minEvents?: number;
  limit?: number;
  /** Name-only clusters. Off by default — see the header. */
  includeWeak?: boolean;
  /** The user's own keys, so they are never "someone you keep running into". */
  selfKeys?: string[];
};

export async function listRepeatCoAttendees(
  userId: string,
  options: RepeatOptions = {}
): Promise<RepeatPerson[]> {
  const minEvents = options.minEvents ?? 2;
  const limit = options.limit ?? 12;
  const db = await getDb();

  const rows = rowsOf<{
    cluster_key: string;
    contact_id: string | null;
    name: string | null;
    company: string | null;
    title: string | null;
    linkedin_url: string | null;
    events_together: string | number;
    last_together_at: string | Date | null;
    connected: boolean;
    kinds: string[];
  }>(
    await db.execute(sql`
      SELECT ${CLUSTER} AS cluster_key,
             MAX(COALESCE(a.contact_id::text, ci.contact_id::text)) AS contact_id,
             -- The longest name wins: "Ada Lovelace" beats "Ada", which is what a
             -- first-name-only guest list gives us.
             (ARRAY_AGG(a.full_name ORDER BY length(COALESCE(a.full_name, '')) DESC))[1] AS name,
             (ARRAY_AGG(a.company ORDER BY (a.company IS NULL), e.starts_at DESC))[1] AS company,
             (ARRAY_AGG(a.title ORDER BY (a.title IS NULL), e.starts_at DESC))[1] AS title,
             (ARRAY_AGG(a.linkedin_url ORDER BY (a.linkedin_url IS NULL)))[1] AS linkedin_url,
             COUNT(DISTINCT a.event_id) AS events_together,
             MAX(e.starts_at) AS last_together_at,
             BOOL_OR(a.contact_id IS NOT NULL) AS connected,
             ARRAY_AGG(DISTINCT a.person_key_kind) AS kinds
        FROM event_attendees a
        JOIN events e ON e.id = a.event_id AND e.user_id = a.user_id
        ${IDENTITY_JOIN}
       WHERE a.user_id = ${userId}
         AND a.person_key_value IS NOT NULL
         -- Hidden events are not events the user went to, so they cannot make a pattern.
         AND e.dismissed_at IS NULL
         AND COALESCE(e.rsvp_status, '') <> 'cancelled'
         ${
           options.includeWeak
             ? sql``
             : sql`AND a.person_key_kind <> 'name'`
         }
         ${
           options.selfKeys && options.selfKeys.length > 0
             ? // One placeholder per key. Drizzle renders a JS array as a single parameter,
               // which Postgres then tries to read as an array literal and rejects.
               sql`AND (a.person_key_kind || ':' || a.person_key_value) NOT IN (${sql.join(
                 options.selfKeys.map((key) => sql`${key}`),
                 sql`, `
               )})`
             : sql``
         }
       GROUP BY ${CLUSTER}
      HAVING COUNT(DISTINCT a.event_id) >= ${minEvents}
       ORDER BY COUNT(DISTINCT a.event_id) DESC, MAX(e.starts_at) DESC NULLS LAST
       LIMIT ${limit}
    `)
  );

  return rows.map((row) => ({
    clusterKey: row.cluster_key,
    contactId: row.contact_id,
    name: row.name,
    company: row.company,
    title: row.title,
    linkedinUrl: row.linkedin_url,
    eventsTogether: Number(row.events_together),
    lastTogetherAt: row.last_together_at ? new Date(row.last_together_at) : null,
    connected: Boolean(row.connected),
    weak: (row.kinds ?? []).every((kind) => kind === "name"),
  }));
}

/**
 * For one event's roster: how many events each row's person has been to with the user.
 *
 * Scoped to this event's own keys rather than aggregating the whole history and filtering in
 * JS — a user with years of rosters has thousands of clusters and one event has thirty rows.
 */
export async function eventsTogetherForRoster(
  userId: string,
  eventId: string
): Promise<Map<string, { count: number; lastAt: Date | null }>> {
  const db = await getDb();
  const rows = rowsOf<{
    attendee_id: string;
    events_together: string | number;
    last_together_at: string | Date | null;
  }>(
    await db.execute(sql`
      WITH roster AS (
        SELECT id, person_key_kind, person_key_value
          FROM event_attendees
         WHERE user_id = ${userId} AND event_id = ${eventId}
           AND person_key_value IS NOT NULL
      )
      SELECT r.id AS attendee_id,
             COUNT(DISTINCT a.event_id) AS events_together,
             MAX(e.starts_at) AS last_together_at
        FROM roster r
        JOIN event_attendees a
          ON a.user_id = ${userId}
         AND a.person_key_kind = r.person_key_kind
         AND a.person_key_value = r.person_key_value
        JOIN events e ON e.id = a.event_id AND e.user_id = ${userId} AND e.dismissed_at IS NULL
       GROUP BY r.id
    `)
  );

  const out = new Map<string, { count: number; lastAt: Date | null }>();
  for (const row of rows) {
    out.set(row.attendee_id, {
      count: Number(row.events_together),
      lastAt: row.last_together_at ? new Date(row.last_together_at) : null,
    });
  }
  return out;
}

export type EventTogether = {
  eventId: string;
  title: string;
  startsAt: Date | null;
  /** Whether the user marked themselves as having spoken to this person there. */
  spokeTo: boolean;
};

/**
 * Every event a given contact appears on a roster for.
 *
 * Matched two ways: rows already connected to them, and rows whose person key matches one of
 * their `contact_identities`. The second is what makes this work before anybody has pressed
 * connect — which is most of the time.
 */
export async function listEventsTogetherForContact(
  userId: string,
  contactId: string,
  limit = 20
): Promise<EventTogether[]> {
  const db = await getDb();
  const rows = rowsOf<{
    event_id: string;
    title: string;
    starts_at: string | Date | null;
    spoke_to: number | boolean;
  }>(
    await db.execute(sql`
      SELECT DISTINCT ON (e.id)
             e.id AS event_id, e.title, e.starts_at, a.spoke_to
        FROM event_attendees a
        JOIN events e ON e.id = a.event_id AND e.user_id = ${userId} AND e.dismissed_at IS NULL
       WHERE a.user_id = ${userId}
         AND (
           a.contact_id = ${contactId}
           OR (
             a.person_key_value IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM contact_identities ci
                WHERE ci.user_id = ${userId}
                  AND ci.contact_id = ${contactId}
                  AND ci.kind = a.person_key_kind
                  AND ci.value = a.person_key_value
             )
           )
         )
       ORDER BY e.id, a.spoke_to DESC
       LIMIT ${limit}
    `)
  );

  return rows
    .map((row) => ({
      eventId: row.event_id,
      title: row.title,
      startsAt: row.starts_at ? new Date(row.starts_at) : null,
      spokeTo: row.spoke_to === 1 || row.spoke_to === true,
    }))
    .sort((a, b) => (b.startsAt?.getTime() ?? 0) - (a.startsAt?.getTime() ?? 0));
}

/**
 * Backfill person keys for rows written before the column existed.
 *
 * Bounded and idempotent, run a slice at a time from the sync pass. Rows whose details
 * identify nobody are stamped with a sentinel kind so they are not reconsidered on every
 * pass — without it the same unidentifiable rows would be re-read forever.
 */
export async function backfillPersonKeys(limit = 2000): Promise<number> {
  const db = await getDb();
  const rows = rowsOf<{
    id: string;
    full_name: string | null;
    email: string | null;
    linkedin_url: string | null;
    x_handle: string | null;
    external_ref: string | null;
  }>(
    await db.execute(sql`
      SELECT id, full_name, email, linkedin_url, x_handle, external_ref
        FROM event_attendees
       WHERE person_key_kind IS NULL
       LIMIT ${limit}
    `)
  );
  if (rows.length === 0) return 0;

  const values = rows.map((row) => {
    const key = personKeyOf({
      fullName: row.full_name,
      email: row.email,
      linkedinUrl: row.linkedin_url,
      xHandle: row.x_handle,
      externalRef: row.external_ref,
    });
    return sql`(${row.id}::uuid, ${key?.kind ?? "none"}::text, ${key?.value ?? null}::text)`;
  });

  await db.execute(sql`
    UPDATE event_attendees AS a
       SET person_key_kind = v.kind, person_key_value = v.value
      FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, kind, value)
     WHERE a.id = v.id
  `);
  return rows.length;
}

export type { PersonKeyKind };
