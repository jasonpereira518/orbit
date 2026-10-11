import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, targetCompanies } from "@/db/schema";
import { companyMatchKeys } from "@/lib/events/company-list-parse";
import { loadTargetKeys } from "@/lib/events/companies";
import { listSchools } from "@/lib/events/target-companies";
import { sharesSchool } from "@/lib/school-name";

/**
 * The Alumni and Target companies filters, matched with the same rules the rest of Orbit uses
 * (`sharesSchool`, `companyMatchKeys`), not a SQL approximation of them. Each returns the exact
 * stored values that match, for an `IN (...)` on the contacts query.
 * ponytail: reads the user's distinct schools/companies per filtered page load; fine at
 * thousands of contacts, cache per request if it ever shows in a profile.
 */
async function distinctValues(userId: string, column: typeof contacts.school | typeof contacts.company): Promise<string[]> {
  const db = await getDb();
  const rows = await db.selectDistinct({ v: column }).from(contacts).where(and(eq(contacts.userId, userId), isNotNull(column)));
  return rows.map((r) => r.v).filter((v): v is string => Boolean(v && v.trim()));
}

export async function alumniSchoolValues(userId: string): Promise<string[]> {
  const [mine, theirs] = await Promise.all([listSchools(userId), distinctValues(userId, contacts.school)]);
  if (!mine.length) return [];
  return theirs.filter((s) => sharesSchool(mine, [s]));
}

export async function targetCompanyValues(userId: string): Promise<string[]> {
  const [keys, theirs] = await Promise.all([loadTargetKeys(userId), distinctValues(userId, contacts.company)]);
  if (!keys.size) return [];
  return theirs.filter((c) => companyMatchKeys(c).some((k) => keys.has(k)));
}

export async function audienceFilterAvailability(userId: string): Promise<{ hasSchools: boolean; hasTargets: boolean }> {
  const db = await getDb();
  const [schools, [targets]] = await Promise.all([
    listSchools(userId),
    db.select({ n: sql<number>`count(*)::int` }).from(targetCompanies).where(eq(targetCompanies.userId, userId)),
  ]);
  return { hasSchools: schools.length > 0, hasTargets: (targets?.n ?? 0) > 0 };
}
