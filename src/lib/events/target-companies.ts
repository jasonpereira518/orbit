/**
 * The companies the user is actually trying to reach.
 *
 * Orbit knows a great deal about who the user HAS met and almost nothing about who they are
 * trying to meet. Goals (`user_goals`) carry some of it in prose, and `goalRelevanceComponent`
 * token-matches against that — which works, and cannot tell "I want to work at Stripe" from
 * "we use Stripe".
 *
 * A short explicit list closes that gap, and it is the single highest-signal input the
 * relevance score has: at a career fair with thirty booths, "three of these are on your list"
 * is the whole answer.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { targetCompanies } from "@/db/schema";
import { resolveCompany } from "@/lib/companies";

/** 1 dream, 2 target, 3 curious. Ordered so a plain sort puts the keenest first. */
export type TargetPriority = 1 | 2 | 3;

export type TargetCompanyRow = {
  id: string;
  companyId: string;
  name: string;
  priority: TargetPriority;
  note: string | null;
  /** How many contacts the user already has there — the reason to look. */
  contactCount: number;
};

export async function listTargetCompanies(userId: string): Promise<TargetCompanyRow[]> {
  const db = await getDb();
  const rows = rowsOf<{
    id: string;
    company_id: string;
    name: string;
    priority: number;
    note: string | null;
    contacts: string | number;
  }>(
    await db.execute(sql`
      SELECT tc.id, tc.company_id, co.name, tc.priority, tc.note,
             (SELECT COUNT(*) FROM contacts c
               WHERE c.user_id = ${userId} AND c.company_id = tc.company_id) AS contacts
        FROM target_companies tc
        JOIN companies co ON co.id = tc.company_id
       WHERE tc.user_id = ${userId}
       ORDER BY tc.priority, co.name
    `)
  );
  return rows.map((row) => ({
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    priority: (row.priority as TargetPriority) ?? 2,
    note: row.note,
    contactCount: Number(row.contacts),
  }));
}

/**
 * Add a company to the list, or move one already on it.
 *
 * Goes through `resolveCompany` so a target and a contact's employer are the SAME company
 * row. Without that the panel could never say "you know two people at one of your targets",
 * which is the only reason the list is worth keeping.
 */
export async function addTargetCompany(
  userId: string,
  name: string,
  priority: TargetPriority = 2,
  note?: string | null
): Promise<{ ok: boolean; error?: string }> {
  const company = await resolveCompany(userId, name);
  if (!company) return { ok: false, error: "Give the company a name first" };

  const db = await getDb();
  await db.execute(sql`
    INSERT INTO target_companies (user_id, company_id, priority, note)
    VALUES (${userId}, ${company.id}::uuid, ${priority}, ${note ?? null})
    ON CONFLICT (user_id, company_id) DO UPDATE SET
      priority = excluded.priority,
      note = COALESCE(excluded.note, target_companies.note)
  `);
  return { ok: true };
}

export async function removeTargetCompany(userId: string, id: string): Promise<void> {
  const db = await getDb();
  await db
    .delete(targetCompanies)
    .where(and(eq(targetCompanies.id, id), eq(targetCompanies.userId, userId)));
}

/** The schools the user attended, for the shared-alma-mater signal. */
export async function listSchools(userId: string): Promise<string[]> {
  const db = await getDb();
  const rows = rowsOf<{ schools: string[] | null }>(
    await db.execute(sql`SELECT schools FROM user_settings WHERE user_id = ${userId} LIMIT 1`)
  );
  const schools = rows[0]?.schools;
  return Array.isArray(schools) ? schools.filter((s) => typeof s === "string") : [];
}

export async function setSchools(userId: string, schools: string[]): Promise<void> {
  const db = await getDb();
  const cleaned = [
    ...new Set(
      schools
        .map((school) => school.trim().replace(/\s+/g, " "))
        .filter((school) => school.length > 0 && school.length <= 120)
    ),
  ].slice(0, 10);

  await db.execute(sql`
    INSERT INTO user_settings (user_id, schools)
    VALUES (${userId}, ${JSON.stringify(cleaned)}::jsonb)
    ON CONFLICT (user_id) DO UPDATE SET schools = excluded.schools, updated_at = now()
  `);
}
