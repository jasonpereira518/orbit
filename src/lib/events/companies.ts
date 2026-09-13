/**
 * Companies at an event, and the people they connect you to.
 *
 * ## Why a company is a better handle than a person
 *
 * A career fair hands you thirty booths and no names. A conference roster hands you four
 * hundred names and no structure. In both cases the useful question is the same: WHICH OF
 * THESE DO I ALREADY HAVE A WAY INTO — and that is a company question, because Orbit already
 * knows where your contacts work and where they used to work.
 *
 * So the panel answers, per company: who you know there now, who used to be there, and who
 * from there was in the room. The third is what makes a stranger approachable; the first two
 * are what make an introduction possible.
 *
 * ## What gets a `companies` row and what does not
 *
 * Curated companies — hosts, sponsors, exhibitors, the employer list from a fair — are
 * resolved into real `companies` rows, because the user named them.
 *
 * Attendee employers are NOT. A 900-person conference would otherwise manufacture hundreds of
 * company records out of self-reported job titles, most of them typos, all of them polluting
 * every company picker in the product forever. They are grouped live from the generated
 * `event_attendees.company_key` instead, which costs one indexed aggregate and creates nothing.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { eventCompanies } from "@/db/schema";
import { createCompanyResolver } from "@/lib/companies";
import { companyMatchKeys } from "@/lib/events/company-list-parse";

export type EventCompanyRole = "host" | "sponsor" | "exhibitor" | "employer";
export type EventCompanySource = "page" | "paste" | "screenshot" | "ai" | "manual";

export type CompanyInput = {
  name: string;
  role: EventCompanyRole;
  source: EventCompanySource;
  evidence?: string | null;
};

/**
 * Record who was there, in one batch.
 *
 * `resolveCompany` is reused rather than inserting directly, so an event's exhibitor and a
 * contact's employer converge on ONE company row — which is the entire point: without it the
 * panel could never say "you know someone there".
 */
export async function upsertEventCompanies(
  userId: string,
  eventId: string,
  inputs: CompanyInput[]
): Promise<number> {
  if (inputs.length === 0) return 0;
  const db = await getDb();
  // The batching resolver, primed: a fair's employer list is forty names at once, and
  // `resolveCompany` per row would be two statements each — see `prime`'s own comment for
  // why the cache alone does not save a concurrent batch.
  const resolve = await createCompanyResolver(userId);
  await resolve.prime(inputs.map((input) => input.name));

  const values: ReturnType<typeof sql>[] = [];
  for (const input of inputs) {
    const company = await resolve(input.name);
    if (!company) continue;
    values.push(
      sql`(${userId}, ${eventId}::uuid, ${company.id}::uuid, ${input.role}, ${input.source},
           ${input.evidence ?? null})`
    );
  }
  if (values.length === 0) return 0;

  await db.execute(sql`
    INSERT INTO event_companies (user_id, event_id, company_id, role, source, evidence)
    VALUES ${sql.join(values, sql`, `)}
    ON CONFLICT (event_id, company_id, role) DO UPDATE SET
      -- Re-adding something the user dismissed un-dismisses it: pasting the list again is an
      -- explicit statement, and silently keeping it hidden would look like a broken import.
      dismissed_at = NULL,
      evidence     = COALESCE(event_companies.evidence, excluded.evidence),
      updated_at   = now()
  `);
  return values.length;
}

export async function dismissEventCompany(userId: string, id: string): Promise<void> {
  const db = await getDb();
  await db
    .update(eventCompanies)
    .set({ dismissedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(eventCompanies.id, id), eq(eventCompanies.userId, userId)));
}

export type CompanyPanelPerson = {
  contactId: string;
  name: string;
  title: string | null;
  /** `now` — works there today. `past` — used to, per their experience history. */
  tenure: "now" | "past";
};

export type EventCompanyRow = {
  /** Null for an attendee-employer group, which has no `event_companies` row by design. */
  id: string | null;
  companyId: string | null;
  name: string;
  role: EventCompanyRole | "attendee_employer";
  source: EventCompanySource | null;
  evidence: string | null;
  /** How many people on THIS roster gave this company as their employer. */
  attendeeCount: number;
  /** Contacts you already have there — the way in. */
  contacts: CompanyPanelPerson[];
  /** Whether the user has flagged this company as somewhere they want to get. */
  targetPriority: number | null;
};

/** Contacts at a set of companies, by name key — current employer and past roles alike. */
async function contactsAtCompanies(
  userId: string,
  keys: string[]
): Promise<Map<string, CompanyPanelPerson[]>> {
  const out = new Map<string, CompanyPanelPerson[]>();
  if (keys.length === 0) return out;
  const db = await getDb();
  const list = sql.join(
    keys.map((key) => sql`${key}`),
    sql`, `
  );

  const rows = rowsOf<{
    key: string;
    contact_id: string;
    full_name: string;
    title: string | null;
    tenure: "now" | "past";
  }>(
    await db.execute(sql`
      -- Current employer, by the same normalisation the generated column uses.
      SELECT ${sql.raw("regexp_replace(regexp_replace(lower(c.company), '[^a-z0-9\\s]', ' ', 'g'), '\\s+', ' ', 'g')")} AS key,
             c.id AS contact_id, c.full_name, c.title, 'now'::text AS tenure
        FROM contacts c
       WHERE c.user_id = ${userId}
         AND c.company IS NOT NULL
         AND trim(${sql.raw("regexp_replace(regexp_replace(lower(c.company), '[^a-z0-9\\s]', ' ', 'g'), '\\s+', ' ', 'g')")}) IN (${list})
      UNION ALL
      -- Anyone who used to be there. The contact_experiences org index covers this, and an
      -- alum is often the better introduction anyway: they will take the call.
      SELECT x.organization_normalized AS key,
             c.id AS contact_id, c.full_name, x.title, 'past'::text AS tenure
        FROM contact_experiences x
        JOIN contacts c ON c.id = x.contact_id AND c.user_id = ${userId}
       WHERE x.user_id = ${userId}
         AND x.organization_normalized IN (${list})
         AND COALESCE(x.is_current, false) = false
      LIMIT 500
    `)
  );

  for (const row of rows) {
    const key = row.key?.trim();
    if (!key) continue;
    const bucket = out.get(key) ?? [];
    // One person can match twice (current job and an old role at the same place).
    if (!bucket.some((person) => person.contactId === row.contact_id)) {
      bucket.push({
        contactId: row.contact_id,
        name: row.full_name,
        title: row.title,
        tenure: row.tenure,
      });
    }
    out.set(key, bucket);
  }
  return out;
}

/**
 * Everything the company panel renders for one event.
 *
 * Four reads, not four-per-company: the curated rows, the roster's employer groups, the
 * contacts at all of those companies at once, and the user's targets.
 */
export async function loadEventCompanyPanel(
  userId: string,
  eventId: string
): Promise<EventCompanyRow[]> {
  const db = await getDb();

  const curated = rowsOf<{
    id: string;
    company_id: string;
    name: string;
    role: EventCompanyRole;
    source: EventCompanySource;
    evidence: string | null;
    priority: number | null;
  }>(
    await db.execute(sql`
      SELECT ec.id, ec.company_id, co.name, ec.role, ec.source, ec.evidence, tc.priority
        FROM event_companies ec
        JOIN companies co ON co.id = ec.company_id
        LEFT JOIN target_companies tc ON tc.company_id = ec.company_id AND tc.user_id = ${userId}
       WHERE ec.user_id = ${userId} AND ec.event_id = ${eventId} AND ec.dismissed_at IS NULL
       ORDER BY ec.role, co.name
    `)
  );

  const employers = rowsOf<{ company_key: string; name: string; attendees: string | number }>(
    await db.execute(sql`
      SELECT company_key,
             -- The longest spelling wins, so the panel shows "Stripe, Inc." rather than "stripe".
             (ARRAY_AGG(company ORDER BY length(company) DESC))[1] AS name,
             COUNT(*) AS attendees
        FROM event_attendees
       WHERE user_id = ${userId} AND event_id = ${eventId} AND company_key IS NOT NULL
       GROUP BY company_key
       ORDER BY COUNT(*) DESC
       LIMIT 40
    `)
  );

  // Every company on the panel, curated or inferred, keyed both ways.
  const keys = new Set<string>();
  for (const row of curated) for (const key of companyMatchKeys(row.name)) keys.add(key);
  for (const row of employers) for (const key of companyMatchKeys(row.name)) keys.add(key);

  const [people, targets] = await Promise.all([
    contactsAtCompanies(userId, [...keys]),
    loadTargetKeys(userId),
  ]);

  const peopleFor = (name: string): CompanyPanelPerson[] => {
    const seen = new Set<string>();
    const out: CompanyPanelPerson[] = [];
    for (const key of companyMatchKeys(name)) {
      for (const person of people.get(key) ?? []) {
        if (seen.has(person.contactId)) continue;
        seen.add(person.contactId);
        out.push(person);
      }
    }
    return out;
  };
  const targetFor = (name: string): number | null => {
    for (const key of companyMatchKeys(name)) {
      const priority = targets.get(key);
      if (priority !== undefined) return priority;
    }
    return null;
  };

  // Summed, not assigned. "Stripe" and "Stripe, Inc." are two groups in the roster (the
  // generated key is per spelling) and one company on the panel, so their counts have to add
  // up — assigning would let whichever group was read last silently replace the other.
  const attendeeCounts = new Map<string, number>();
  for (const row of employers) {
    for (const key of companyMatchKeys(row.name)) {
      attendeeCounts.set(key, (attendeeCounts.get(key) ?? 0) + Number(row.attendees));
    }
  }

  const rows: EventCompanyRow[] = curated.map((row) => ({
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    role: row.role,
    source: row.source,
    evidence: row.evidence,
    attendeeCount: companyMatchKeys(row.name).reduce(
      (max, key) => Math.max(max, attendeeCounts.get(key) ?? 0),
      0
    ),
    contacts: peopleFor(row.name),
    targetPriority: row.priority ?? targetFor(row.name),
  }));

  // Employer groups that are not already on the panel under a curated role.
  const curatedKeys = new Set(curated.flatMap((row) => companyMatchKeys(row.name)));
  for (const row of employers) {
    if (companyMatchKeys(row.name).some((key) => curatedKeys.has(key))) continue;
    rows.push({
      id: null,
      companyId: null,
      name: row.name,
      role: "attendee_employer",
      source: null,
      evidence: null,
      attendeeCount: Number(row.attendees),
      contacts: peopleFor(row.name),
      targetPriority: targetFor(row.name),
    });
  }

  // Most useful first: somewhere you are trying to get, then where you already know people,
  // then where the most people in the room came from.
  return rows.sort((a, b) => {
    const target = (a.targetPriority ?? 9) - (b.targetPriority ?? 9);
    if (target !== 0) return target;
    if (b.contacts.length !== a.contacts.length) return b.contacts.length - a.contacts.length;
    return b.attendeeCount - a.attendeeCount;
  });
}

/** The user's target companies, keyed for comparison. Shared with relevance scoring. */
export async function loadTargetKeys(userId: string): Promise<Map<string, number>> {
  const db = await getDb();
  const rows = rowsOf<{ name: string; priority: number }>(
    await db.execute(sql`
      SELECT co.name, tc.priority
        FROM target_companies tc
        JOIN companies co ON co.id = tc.company_id
       WHERE tc.user_id = ${userId}
    `)
  );
  const out = new Map<string, number>();
  for (const row of rows) {
    for (const key of companyMatchKeys(row.name)) {
      const existing = out.get(key);
      // The strongest priority wins when two spellings collide.
      if (existing === undefined || row.priority < existing) out.set(key, row.priority);
    }
  }
  return out;
}
