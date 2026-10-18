import { sql, type SQL } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";

/**
 * "What does Orbit hold about me?" from someone who is NOT an Orbit user.
 *
 * People in a user's network never signed up, but they can ask what Orbit holds about them,
 * or ask to be removed (PRIVACY_AUDIT.md F-08). Answering means searching every account,
 * which nothing in the product does — every read is scoped to one user by design. This is the
 * operator's tool for that one job, run from `scripts/privacy-lookup.ts`.
 *
 * It reports WHERE the person appears — which table, how many rows, which accounts — and
 * never what those rows say: the operator needs to know whom to tell and what to remove, not
 * to read users' notes. Matching is exact on a normalised email and on the LinkedIn profile
 * slug; free text (notes, transcripts) is not searched, because a name is not an identity.
 */
export type PersonLookupInput = { email?: string | null; linkedinUrl?: string | null };

export type PersonLookupHit = {
  table: string;
  /** What kind of record this is, in a sentence the operator can repeat to the requester. */
  what: string;
  rows: number;
  /** Account ids holding these rows; empty for tables Orbit controls (global tables). */
  accounts: string[];
};

/** The profile slug of a LinkedIn URL (`/in/<slug>`), lower-cased, or null. */
export function linkedinSlug(url: string | null | undefined): string | null {
  const match = url?.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]).toLowerCase() : null;
}

type Probe = { table: string; what: string; where: (email: string | null, slug: string | null) => SQL | null; owner: SQL | null; from?: SQL };

const PROBES: Probe[] = [
  {
    table: "user_settings",
    what: "an Orbit account of their own",
    where: (email) => (email ? sql`lower(email) = ${email}` : null),
    owner: sql`user_id`,
  },
  {
    table: "contacts",
    what: "a contact in a user's network",
    where: (email, slug) =>
      email || slug
        ? sql`(${email ? sql`lower(email) = ${email}` : sql`false`} OR ${slug ? sql`lower(linkedin_url) LIKE ${`%/in/${slug}%`}` : sql`false`})`
        : null,
    owner: sql`user_id`,
  },
  {
    table: "contact_identities",
    what: "an address or profile Orbit uses to recognise a contact",
    where: (email, slug) =>
      email || slug
        ? sql`(${email ? sql`lower(value) = ${email}` : sql`false`} OR ${slug ? sql`lower(value) LIKE ${`%${slug}%`}` : sql`false`})`
        : null,
    owner: sql`user_id`,
  },
  {
    table: "event_attendees",
    what: "a guest on an event a user tracked",
    where: (email, slug) =>
      email || slug
        ? sql`(${email ? sql`lower(email) = ${email}` : sql`false`} OR ${slug ? sql`lower(linkedin_url) LIKE ${`%/in/${slug}%`}` : sql`false`})`
        : null,
    owner: sql`user_id`,
  },
  {
    table: "user_recruiter_links",
    what: "a recruiter a user linked to",
    where: (email, slug) =>
      email || slug
        ? sql`(${email ? sql`lower(email) = ${email}` : sql`false`} OR ${slug ? sql`lower(linkedin_url) LIKE ${`%/in/${slug}%`}` : sql`false`})`
        : null,
    owner: sql`user_id`,
  },
  {
    table: "recruiters",
    what: "the shared recruiter directory (Orbit controls this)",
    where: (email, slug) =>
      email || slug
        ? sql`(${email ? sql`email_normalized = ${email}` : sql`false`} OR ${slug ? sql`lower(linkedin_url) LIKE ${`%/in/${slug}%`}` : sql`false`})`
        : null,
    owner: null,
  },
  {
    table: "outreach_prospects",
    what: "a prospect in a user's outreach campaign",
    where: (email, slug) =>
      email || slug
        ? sql`(${email ? sql`lower(p.email) = ${email}` : sql`false`} OR ${slug ? sql`lower(p.linkedin_url) LIKE ${`%/in/${slug}%`}` : sql`false`})`
        : null,
    owner: sql`c.user_id`,
    from: sql`outreach_prospects p JOIN outreach_campaigns c ON c.id = p.campaign_id`,
  },
  {
    table: "calendar_events",
    what: "a guest on a meeting in a user's calendar",
    where: (email) => (email ? sql`(lower(organizer_email) = ${email} OR lower(attendees::text) LIKE ${`%"${email}"%`})` : null),
    owner: sql`user_id`,
  },
  {
    table: "email_sends",
    what: "a recipient of email a user sent from Orbit",
    where: (email) => (email ? sql`lower(to_emails::text || cc::text || bcc::text) LIKE ${`%"${email}"%`}` : null),
    owner: sql`user_id`,
  },
  {
    table: "interest_list_signups",
    what: "the waitlist (Orbit controls this)",
    where: (email) => (email ? sql`lower(email) = ${email}` : null),
    owner: null,
  },
  {
    table: "linkedin_avatars",
    what: "the shared cache of public LinkedIn photos (Orbit controls this)",
    where: (_email, slug) => (slug ? sql`lower(slug) = ${slug}` : null),
    owner: null,
  },
];

export async function findPersonAcrossAccounts(input: PersonLookupInput): Promise<PersonLookupHit[]> {
  const email = input.email?.trim().toLowerCase() || null;
  const slug = linkedinSlug(input.linkedinUrl);
  if (!email && !slug) throw new Error("Give an email address or a LinkedIn profile URL");
  const db = await getDb();
  const hits: PersonLookupHit[] = [];
  for (const probe of PROBES) {
    const where = probe.where(email, slug);
    if (!where) continue;
    const from = probe.from ?? sql.identifier(probe.table);
    const owner = probe.owner ?? sql`NULL::text`;
    const rows = rowsOf<{ owner: string | null; n: number }>(
      await db.execute(sql`SELECT ${owner} AS owner, count(*)::int AS n FROM ${from} WHERE ${where} GROUP BY 1`)
    );
    const total = rows.reduce((sum, r) => sum + Number(r.n), 0);
    if (total === 0) continue;
    hits.push({
      table: probe.table,
      what: probe.what,
      rows: total,
      accounts: rows.map((r) => r.owner).filter((id): id is string => Boolean(id)).sort(),
    });
  }
  return hits;
}
