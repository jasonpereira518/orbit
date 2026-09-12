import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { contacts, noteBatches } from "@/db/schema";

/** A name the note parser found but could not match to anyone. */
export type UnresolvedMention = {
  text: string;
  context: string | null;
  noteAt: string;
};

/** How far back to look. Older than this and the note has stopped being on your mind. */
const UNRESOLVED_WINDOW_DAYS = 30;
const UNRESOLVED_BATCH_LIMIT = 20;
const UNRESOLVED_NAME_LIMIT = 6;

/**
 * People named in your recent notes who are still not in your network.
 *
 * The note parser already records these, and the capture *results* page already lists them
 * with an "Add as contact" link — but that page is a receipt for one paste, seen once. If
 * you do not act in that moment the name is gone, even though it is exactly the kind of
 * thing worth coming back to. This is the standing version.
 *
 * The important part is the second query: a name that has since been added must drop off,
 * or the list becomes a pile of things you already did. Two statements, on a page load
 * only — deliberately not in the notification panel, which polls every 90 seconds for
 * every open tab and would pay this cost for everyone whether or not they capture notes.
 */
export async function listUnresolvedMentionsFor(
  userId: string
): Promise<UnresolvedMention[]> {
  const db = await getDb();

  const since = new Date(Date.now() - UNRESOLVED_WINDOW_DAYS * 86_400_000);
  const batches = await db
    .select({ result: noteBatches.result, createdAt: noteBatches.createdAt })
    .from(noteBatches)
    .where(
      and(
        eq(noteBatches.userId, userId),
        eq(noteBatches.status, "saved"),
        gte(noteBatches.createdAt, since)
      )
    )
    .orderBy(desc(noteBatches.createdAt))
    .limit(UNRESOLVED_BATCH_LIMIT)
    .catch(() => []);

  // Newest mention of a given name wins, so the context line is the freshest one.
  const byName = new Map<string, UnresolvedMention>();
  for (const batch of batches) {
    for (const m of batch.result?.unresolvedMentions ?? []) {
      const text = m.text?.trim();
      if (!text) continue;
      const key = text.toLowerCase();
      if (byName.has(key)) continue;
      byName.set(key, {
        text,
        context: m.context?.trim() || null,
        noteAt: batch.createdAt.toISOString(),
      });
    }
  }
  if (!byName.size) return [];

  const names = [...byName.keys()];
  const known = await db
    .select({ name: sql<string>`lower(${contacts.fullName})` })
    .from(contacts)
    .where(
      and(
        eq(contacts.userId, userId),
        or(
          inArray(sql`lower(${contacts.fullName})`, names),
          inArray(sql`lower(coalesce(${contacts.preferredName}, ''))`, names)
        )
      )
    )
    .catch(() => []);
  const resolved = new Set(known.map((r) => r.name));

  return [...byName.entries()]
    .filter(([key]) => !resolved.has(key))
    .map(([, value]) => value)
    .slice(0, UNRESOLVED_NAME_LIMIT);
}
