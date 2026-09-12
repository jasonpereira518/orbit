/**
 * Action items as rows with completion state. `interactions.action_items` (string[]) stays
 * as a write-through denorm for the timeline and the extension; this table is what the
 * profile checklist and reminders link to.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { actionItems, interactions } from "@/db/schema";

export const MAX_ACTION_ITEMS_PER_INTERACTION = 10;

/** Must equal the SQL in src/db/index.ts ADMIN_V2_STATEMENTS: sha256(id || '|' || lower(btrim(text))). */
export function actionItemHash(interactionId: string, text: string) {
  return createHash("sha256").update(`${interactionId}|${text.replace(/^ +| +$/g, "").toLowerCase()}`).digest("hex");
}

export type ExistingActionItem = { id: string; itemHash: string; status: "open" | "done"; reminderId: string | null };

export function diffActionItems(
  existing: ExistingActionItem[],
  incoming: string[],
  hash: (text: string) => string = (t) => t.trim().toLowerCase()
) {
  const byHash = new Map(existing.map((e) => [e.itemHash, e]));
  const seen = new Set<string>();
  const insert: { text: string; position: number; itemHash: string }[] = [];
  let position = 0;
  for (const raw of incoming) {
    // Space-only trim, matching actionItemHash() and the SQL `btrim` it mirrors. JS
    // `.trim()` also strips tabs and newlines, so a "\tTabbed item" would be stored
    // trimmed here but hashed untrimmed by the SQL backfill — the same item twice.
    const text = raw.replace(/^ +| +$/g, "");
    if (!text) continue;
    const itemHash = hash(text);
    if (seen.has(itemHash)) continue;
    seen.add(itemHash);
    if (!byHash.has(itemHash)) insert.push({ text, position, itemHash });
    position += 1;
    if (position >= MAX_ACTION_ITEMS_PER_INTERACTION) break;
  }
  const deleteIds = existing
    .filter((e) => !seen.has(e.itemHash) && e.status !== "done" && !e.reminderId)
    .map((e) => e.id);
  return { insert, deleteIds };
}

export async function syncActionItems(userId: string, interactionId: string, contactId: string, texts: string[]) {
  const db = await getDb();
  const existing = await db
    .select({ id: actionItems.id, itemHash: actionItems.itemHash, status: actionItems.status, reminderId: actionItems.reminderId })
    .from(actionItems)
    .where(and(eq(actionItems.userId, userId), eq(actionItems.interactionId, interactionId)));
  const { insert, deleteIds } = diffActionItems(existing, texts, (t) => actionItemHash(interactionId, t));
  let inserted: { id: string; text: string }[] = [];
  if (insert.length) {
    // Bare `.returning()`, not `.returning({ id, text })` — an explicit field selector
    // defeats Drizzle's overload resolution against the union `Db` type after
    // `.onConflictDoNothing()` (same issue noted in import-engine.ts and interest-list.ts).
    const rows = await db
      .insert(actionItems)
      .values(insert.map((x) => ({ userId, contactId, interactionId, text: x.text, position: x.position, itemHash: x.itemHash })))
      .onConflictDoNothing({ target: [actionItems.userId, actionItems.itemHash] })
      .returning();
    inserted = rows.map((r) => ({ id: r.id, text: r.text }));
  }
  if (deleteIds.length) {
    await db.delete(actionItems).where(and(eq(actionItems.userId, userId), inArray(actionItems.id, deleteIds)));
  }
  return { inserted, deletedIds: deleteIds };
}

export async function listOpenActionItems(userId: string, contactId: string) {
  const db = await getDb();
  return db
    .select({ id: actionItems.id, text: actionItems.text, interactionId: actionItems.interactionId, interactionDate: interactions.interactionDate, reminderId: actionItems.reminderId })
    .from(actionItems)
    .innerJoin(interactions, eq(interactions.id, actionItems.interactionId))
    .where(and(eq(actionItems.userId, userId), eq(actionItems.contactId, contactId), eq(actionItems.status, "open")))
    .orderBy(desc(interactions.interactionDate), actionItems.position);
}

export async function setActionItemStatusForUser(userId: string, id: string, status: "open" | "done") {
  const db = await getDb();
  // Bare `.returning()` — see the note in syncActionItems above.
  const [row] = await db
    .update(actionItems)
    .set({ status, completedAt: status === "done" ? new Date() : null })
    .where(and(eq(actionItems.id, id), eq(actionItems.userId, userId)))
    .returning();
  return row ? { contactId: row.contactId, reminderId: row.reminderId } : null;
}
