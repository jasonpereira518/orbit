import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { companies, contacts } from "@/db/schema";
import {
  displayCompanyName,
  normalizeCompanyName,
} from "@/lib/company-name";

export { displayCompanyName, normalizeCompanyName } from "@/lib/company-name";

/**
 * Find or create a per-user company row. Case/whitespace-equivalent names reuse
 * the existing row and canonical display name.
 */
export async function resolveCompany(
  userId: string,
  rawName: string | null | undefined
): Promise<{ id: string; name: string } | null> {
  const display = rawName ? displayCompanyName(rawName) : "";
  if (!display) return null;

  const normalized = normalizeCompanyName(display);
  const db = await getDb();

  const existing = await db.query.companies.findFirst({
    where: and(
      eq(companies.userId, userId),
      eq(companies.nameNormalized, normalized)
    ),
  });

  if (existing) {
    return { id: existing.id, name: existing.name };
  }

  try {
    const [created] = await db
      .insert(companies)
      .values({
        userId,
        name: display,
        nameNormalized: normalized,
      })
      .returning();
    return { id: created.id, name: created.name };
  } catch {
    // Race on unique index — fetch winner
    const raced = await db.query.companies.findFirst({
      where: and(
        eq(companies.userId, userId),
        eq(companies.nameNormalized, normalized)
      ),
    });
    if (raced) return { id: raced.id, name: raced.name };
    throw new Error(`Could not resolve company: ${display}`);
  }
}

/** Attach companyId + canonical company text for a contact write. */
export async function companyFieldsForWrite(
  userId: string,
  rawName: string | null | undefined
): Promise<{ companyId: string | null; company: string | null }> {
  const resolved = await resolveCompany(userId, rawName);
  if (!resolved) return { companyId: null, company: null };
  return { companyId: resolved.id, company: resolved.name };
}

/**
 * Link existing free-text company values to companies rows and canonicalize
 * contact.company to the shared display name.
 */
export async function backfillContactCompanies(userId?: string) {
  const db = await getDb();
  const candidates = await db.query.contacts.findMany({
    where: userId
      ? and(eq(contacts.userId, userId), isNull(contacts.companyId))
      : isNull(contacts.companyId),
    columns: { id: true, userId: true, company: true },
  });

  const orphans = candidates.filter((row) => Boolean(row.company?.trim()));

  let linked = 0;
  for (const row of orphans) {
    const resolved = await resolveCompany(row.userId, row.company);
    if (!resolved) continue;
    await db
      .update(contacts)
      .set({
        companyId: resolved.id,
        company: resolved.name,
        updatedAt: new Date(),
      })
      .where(eq(contacts.id, row.id));
    linked++;
  }
  return { linked, scanned: orphans.length };
}
