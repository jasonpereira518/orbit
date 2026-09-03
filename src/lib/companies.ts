import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { companies } from "@/db/schema";
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

export type CompanyResolver = ((
  rawName: string | null | undefined
) => Promise<{ id: string; name: string } | null>) & {
  /**
   * Resolve a whole batch of names in two statements rather than up to two per *row*.
   *
   * Call this once before resolving a batch concurrently. Without it, a bulk write's
   * `Promise.all(rows.map(...))` fires every lookup simultaneously, so every row sharing
   * the same not-yet-existing company misses the cache at the same instant — the cache is
   * only written once a resolution *completes*, and none have. Each of those rows then
   * pays its own `SELECT` + `INSERT`, and all but the first hits the unique index and pays
   * a third statement in `resolveCompany`'s race-recovery path. That is a per-row cost
   * hiding inside a bulk write, and it is invisible to any benchmark that reuses a database
   * where the companies already exist.
   */
  prime(rawNames: Array<string | null | undefined>): Promise<void>;
};

/**
 * Preloads all of a user's companies into memory and returns a resolver that
 * avoids a DB round trip per lookup for names already seen. Falls back to
 * `resolveCompany` (find-or-create) for cache misses, then caches the result.
 * Use for bulk operations (e.g. CSV import) instead of calling `resolveCompany`
 * once per row — and call `prime()` on each batch first, for the reason its own
 * doc comment gives.
 */
export async function createCompanyResolver(
  userId: string
): Promise<CompanyResolver> {
  const db = await getDb();
  const existing = await db.query.companies.findMany({
    where: eq(companies.userId, userId),
  });
  const cache = new Map<string, { id: string; name: string }>(
    existing.map((row) => [row.nameNormalized, { id: row.id, name: row.name }])
  );

  const resolve = (async (rawName) => {
    const display = rawName ? displayCompanyName(rawName) : "";
    if (!display) return null;
    const normalized = normalizeCompanyName(display);

    const cached = cache.get(normalized);
    if (cached) return cached;

    const resolved = await resolveCompany(userId, rawName);
    if (resolved) cache.set(normalized, resolved);
    return resolved;
  }) as CompanyResolver;

  resolve.prime = async (rawNames) => {
    // Distinct normalized keys only, so the statements below scale with the number of
    // distinct companies in the batch rather than with the number of rows. The first
    // spelling of a name wins as the display value, matching `resolveCompany`'s
    // first-writer-wins behavior.
    const wanted = new Map<string, string>();
    for (const rawName of rawNames) {
      const display = rawName ? displayCompanyName(rawName) : "";
      if (!display) continue;
      const normalized = normalizeCompanyName(display);
      if (cache.has(normalized) || wanted.has(normalized)) continue;
      wanted.set(normalized, display);
    }
    if (wanted.size === 0) return;

    // Statement 1: whatever already exists. The constructor's preload covers everything the
    // user had at job start, but a multi-chunk import creates companies as it goes and a
    // second process may be doing the same, so this is not redundant with it.
    const found = await db.query.companies.findMany({
      where: and(
        eq(companies.userId, userId),
        inArray(companies.nameNormalized, [...wanted.keys()])
      ),
    });
    for (const row of found) {
      cache.set(row.nameNormalized, { id: row.id, name: row.name });
      wanted.delete(row.nameNormalized);
    }
    if (wanted.size === 0) return;

    // Statement 2: create the rest. `DO UPDATE` with a self-assignment rather than
    // `DO NOTHING` purely so conflicting rows still come back from `RETURNING` — a row
    // another process inserted between the SELECT above and this INSERT would otherwise be
    // silently absent from the result and fall through to a per-row lookup, which is the
    // cost this method exists to remove. The keys are distinct by construction, so no
    // single statement can affect the same conflict target twice.
    const inserted = await db
      .insert(companies)
      .values(
        [...wanted].map(([nameNormalized, name]) => ({ userId, name, nameNormalized }))
      )
      .onConflictDoUpdate({
        target: [companies.userId, companies.nameNormalized],
        set: { nameNormalized: sql`excluded.name_normalized` },
      })
      .returning();
    for (const row of inserted) {
      cache.set(row.nameNormalized, { id: row.id, name: row.name });
    }
  };

  return resolve;
}

/** Attach companyId + canonical company text using a preloaded resolver (see `createCompanyResolver`). */
export async function companyFieldsForWriteCached(
  resolve: CompanyResolver,
  rawName: string | null | undefined
): Promise<{ companyId: string | null; company: string | null }> {
  const resolved = await resolve(rawName);
  if (!resolved) return { companyId: null, company: null };
  return { companyId: resolved.id, company: resolved.name };
}
