/**
 * The set-aside list: people a capture did not turn into contacts.
 *
 * Three ways in — a card swiped away (`rejected`), a card skipped for later (`skipped`),
 * and a name the notes only mentioned (`mentioned`) — and two ways out: "Add as contact"
 * from the list, or a contact with that name appearing anywhere, which `listIgnoredPeopleFor`
 * notices and deletes lazily. One row per (user, normalized name); the latest capture's
 * context wins, so the line under the name is always the freshest reason they came up.
 *
 * Auth-free so the job runner (no request scope) and the smoke suite can drive it.
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, ignoredPeople } from "@/db/schema";
import { resolveOrCreateContact } from "@/lib/contact-resolve";
import type { IgnoredPersonReason } from "@/lib/capture/types";

const CONTEXT_MAX = 500;
const LIST_LIMIT = 200;

/** Lowercased, trimmed, inner whitespace collapsed — the row's identity. */
export function normalizePersonKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

export type IgnoredPersonInput = {
  displayName: string;
  reason: IgnoredPersonReason;
  context?: string | null;
  company?: string | null;
  captureJobId?: string | null;
  noteBatchId?: string | null;
};

export type IgnoredPerson = {
  id: string;
  displayName: string;
  reason: IgnoredPersonReason;
  context: string | null;
  company: string | null;
  updatedAt: string;
};

export async function upsertIgnoredPeople(userId: string, rows: IgnoredPersonInput[]): Promise<number> {
  // Dedupe within the batch first: two rows with one key in a single INSERT ... ON CONFLICT
  // is a Postgres error ("cannot affect row a second time"), not a merge.
  const byKey = new Map<string, IgnoredPersonInput>();
  for (const row of rows) {
    const displayName = row.displayName.replace(/\s+/g, " ").trim();
    const key = normalizePersonKey(displayName);
    if (!key) continue;
    byKey.set(key, { ...row, displayName });
  }
  if (!byKey.size) return 0;

  const db = await getDb();
  const now = new Date();
  await db
    .insert(ignoredPeople)
    .values(
      [...byKey.entries()].map(([nameKey, row]) => ({
        userId,
        nameKey,
        displayName: row.displayName,
        reason: row.reason,
        context: row.context?.trim().slice(0, CONTEXT_MAX) || null,
        company: row.company?.trim() || null,
        captureJobId: row.captureJobId ?? null,
        noteBatchId: row.noteBatchId ?? null,
        updatedAt: now,
      }))
    )
    .onConflictDoUpdate({
      target: [ignoredPeople.userId, ignoredPeople.nameKey],
      set: {
        displayName: sql`excluded.display_name`,
        reason: sql`excluded.reason`,
        context: sql`excluded.context`,
        company: sql`excluded.company`,
        captureJobId: sql`excluded.capture_job_id`,
        noteBatchId: sql`excluded.note_batch_id`,
        updatedAt: now,
      },
    });
  return byKey.size;
}

/**
 * The list, newest first, minus anyone who has since become a contact. The check is one
 * query on lower(full_name) / preferred_name, and the matches are deleted rather than
 * filtered so the count on the page button stays honest without repeating the work.
 */
export async function listIgnoredPeopleFor(userId: string): Promise<IgnoredPerson[]> {
  const db = await getDb();
  const rows = await db.query.ignoredPeople.findMany({
    where: eq(ignoredPeople.userId, userId),
    orderBy: (t, { desc }) => [desc(t.updatedAt)],
    limit: LIST_LIMIT,
  });
  if (!rows.length) return [];

  const keys = rows.map((r) => r.nameKey);
  const known = await db
    .select({ name: sql<string>`lower(${contacts.fullName})`, preferred: sql<string>`lower(coalesce(${contacts.preferredName}, ''))` })
    .from(contacts)
    .where(
      and(
        eq(contacts.userId, userId),
        or(
          inArray(sql`lower(${contacts.fullName})`, keys),
          inArray(sql`lower(coalesce(${contacts.preferredName}, ''))`, keys)
        )
      )
    );
  const resolved = new Set<string>();
  for (const k of known) {
    resolved.add(k.name);
    if (k.preferred) resolved.add(k.preferred);
  }
  const stale = rows.filter((r) => resolved.has(r.nameKey));
  if (stale.length) {
    await db.delete(ignoredPeople).where(
      and(eq(ignoredPeople.userId, userId), inArray(ignoredPeople.id, stale.map((r) => r.id)))
    );
  }

  return rows
    .filter((r) => !resolved.has(r.nameKey))
    .map((r) => ({
      id: r.id,
      displayName: r.displayName,
      reason: r.reason,
      context: r.context,
      company: r.company,
      updatedAt: r.updatedAt.toISOString(),
    }));
}

export async function countIgnoredPeopleFor(userId: string): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(ignoredPeople)
    .where(eq(ignoredPeople.userId, userId));
  return row?.n ?? 0;
}

export async function removeIgnoredPerson(userId: string, id: string): Promise<boolean> {
  const db = await getDb();
  const deleted = await db
    .delete(ignoredPeople)
    .where(and(eq(ignoredPeople.userId, userId), eq(ignoredPeople.id, id)))
    .returning();
  return deleted.length > 0;
}

/**
 * "Add as contact": the row becomes a contact through the same funnel every other creator
 * uses, so a name that already exists folds into it rather than duplicating.
 */
export async function promoteIgnoredPerson(
  userId: string,
  id: string
): Promise<{ contactId: string; created: boolean } | null> {
  const db = await getDb();
  const row = await db.query.ignoredPeople.findFirst({
    where: and(eq(ignoredPeople.userId, userId), eq(ignoredPeople.id, id)),
  });
  if (!row) return null;
  const resolved = await resolveOrCreateContact(
    userId,
    {
      fullName: row.displayName,
      company: row.company ?? undefined,
      notes: row.context ?? undefined,
      source: "ai_capture",
    },
    // The action that wraps this revalidates; the lib may run from a smoke script.
    { skipRevalidate: true, skipEmbedding: true, skipSummary: true }
  );
  await db.delete(ignoredPeople).where(eq(ignoredPeople.id, row.id));
  return { contactId: resolved.contactId, created: resolved.outcome === "created" };
}
