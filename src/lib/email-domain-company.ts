/**
 * A company from a work email's domain, for contacts that have none (contact-info accuracy
 * plan, PR 6): "priya@harbor-health.com" → "Harbor Health".
 *
 * The weakest source there is ("email_domain", inferred): it fills an empty company and
 * nothing else, every fill is listed under "Changed by Orbit" with undo, and any better
 * source (an address book, the LinkedIn export, a job move, the person) replaces it. Public
 * mail (gmail.com…) names nobody's employer; school and government domains name an
 * institution, not a job, so they are skipped too.
 */
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { bulkMergeContactsForUser } from "@/lib/contact-writes";
import { createCompanyResolver } from "@/lib/companies";
import { companyFromEmail } from "@/lib/guest-profiles";

const INSTITUTION = /\.(edu|gov|mil)(\.[a-z]{2})?$|\.(ac|edu|gov)\.[a-z]{2}$/i;

/** The company a work address names, or null (public mail, schools, government). Pure. */
export function employerFromEmail(email: string | null | undefined): string | null {
  const domain = email?.split("@")[1]?.trim().toLowerCase();
  if (!domain || INSTITUTION.test(domain)) return null;
  return companyFromEmail(email);
}

/** Fill an empty company from the work email domain, for these contacts. Returns how many. */
export async function fillCompanyFromEmail(userId: string, contactIds: string[]): Promise<number> {
  if (!contactIds.length) return 0;
  const db = await getDb();
  const rows = await db
    .select({ id: contacts.id, email: contacts.email })
    .from(contacts)
    .where(
      and(
        eq(contacts.userId, userId),
        inArray(contacts.id, contactIds.slice(0, 5000)),
        isNotNull(contacts.email),
        or(isNull(contacts.company), eq(contacts.company, ""))
      )
    );
  const merges = rows.flatMap((r) => {
    const company = employerFromEmail(r.email);
    return company ? [{ contactId: r.id, input: { company } }] : [];
  });
  if (!merges.length) return 0;
  await bulkMergeContactsForUser(userId, merges, await createCompanyResolver(userId), { source: "email_domain" });
  return merges.length;
}
