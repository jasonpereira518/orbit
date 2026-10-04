/**
 * One-click writes from the run summary and the profile. Each reminder lands in the run's
 * note batch (so Undo all reaches it) and is keyed by item_hash (a double click or a retry
 * writes nothing new). A flag or thread leaves its list once handled.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { contacts, relationshipDigests, relationshipRuns, reminders } from "@/db/schema";
import { ensureRunNoteBatch } from "@/lib/relationship-engine/apply";
import { getInboxListId } from "@/lib/reminder-lists";
import { buildSuggestionItemHash, isoDay } from "@/lib/suggested-reminder-utils";

/**
 * A one-click promotion: the new reminder, `alreadyMade` when its keyed reminder already
 * exists (a double click that raced), or null when there is nothing to promote any more
 * (flag or thread gone, run undone, contact not yours).
 */
export type PromoteOutcome = { reminderId: string } | { alreadyMade: true } | null;

/** Decision: one-click reminders are due tomorrow, 09:00 UTC. */
function tomorrow(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 9));
}

async function appendReminderToBatch(batchId: string, r: { id: string; contactId: string | null; title: string; dueDate: Date; sourceExcerpt: string | null }) {
  const db = await getDb();
  const entry = { id: r.id, contactId: r.contactId, title: r.title, dueIso: isoDay(r.dueDate), dateBasis: "window", rawDatePhrase: null, sourceExcerpt: r.sourceExcerpt };
  await db.execute(sql`
    UPDATE note_batches
       SET result = jsonb_set(result, '{reminders}', coalesce(result->'reminders', '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb)
     WHERE id = ${batchId}::uuid
  `);
}

async function insertReminder(
  userId: string,
  runId: string,
  input: { contactId: string; title: string; dueDate: Date; excerpt: string | null; interactionId: string | null; hashSeed: string; origin: "explicit" | "implied" }
): Promise<Exclude<PromoteOutcome, null>> {
  const db = await getDb();
  const batchId = await ensureRunNoteBatch(userId, runId);
  const listId = await getInboxListId(userId);
  // Bare `.returning()` — a partial selector breaks on this repo's neon-http/PGlite split.
  const [row] = await db
    .insert(reminders)
    .values({
      userId,
      contactId: input.contactId,
      listId,
      title: input.title.slice(0, 300),
      description: null,
      dueDate: input.dueDate,
      status: "pending",
      reminderType: "ai_suggested",
      createdBy: "ai",
      noteBatchId: batchId,
      sourceInteractionId: input.interactionId,
      sourceExcerpt: input.excerpt?.slice(0, 500) ?? null,
      dateBasis: "window",
      origin: input.origin,
      itemHash: buildSuggestionItemHash(input.hashSeed, isoDay(input.dueDate), input.title),
    })
    .onConflictDoNothing({ target: [reminders.userId, reminders.itemHash] })
    .returning();
  if (!row) return { alreadyMade: true };
  await appendReminderToBatch(batchId, { id: row.id, contactId: row.contactId, title: row.title, dueDate: input.dueDate, sourceExcerpt: row.sourceExcerpt });
  return { reminderId: row.id };
}

async function removeFlag(userId: string, runId: string, key: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(sql`
    UPDATE relationship_runs
       SET flags = coalesce((SELECT jsonb_agg(f) FROM jsonb_array_elements(flags) f WHERE f->>'key' <> ${key}), '[]'::jsonb)
     WHERE id = ${runId}::uuid AND user_id = ${userId}
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(flags) f WHERE f->>'key' = ${key})
     RETURNING id
  `);
  return rowsOf(result).length > 0;
}

export async function promoteRunFlag(userId: string, runId: string, key: string, now: Date = new Date()): Promise<PromoteOutcome> {
  const db = await getDb();
  const run = await db.query.relationshipRuns.findFirst({ where: and(eq(relationshipRuns.id, runId), eq(relationshipRuns.userId, userId)) });
  const flag = run?.flags.find((f) => f.key === key);
  if (!run || !flag || run.status === "undone") return null;
  const owned = await db.query.contacts.findFirst({ where: and(eq(contacts.id, flag.contactId), eq(contacts.userId, userId)), columns: { id: true } });
  if (!owned) return null;
  const made = await insertReminder(userId, runId, {
    contactId: flag.contactId, title: flag.title, dueDate: tomorrow(now), excerpt: flag.sourceExcerpt,
    interactionId: flag.interactionId, hashSeed: `relationship-flag:${flag.key}`, origin: "explicit",
  });
  await removeFlag(userId, runId, key);
  return made;
}

export async function dismissRunFlag(userId: string, runId: string, key: string): Promise<boolean> {
  return removeFlag(userId, runId, key);
}

async function removeThread(userId: string, contactId: string, key: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(sql`
    UPDATE relationship_digests
       SET open_threads = coalesce((SELECT jsonb_agg(t) FROM jsonb_array_elements(open_threads) t WHERE t->>'key' <> ${key}), '[]'::jsonb)
     WHERE contact_id = ${contactId}::uuid AND user_id = ${userId}
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(open_threads) t WHERE t->>'key' = ${key})
     RETURNING contact_id
  `);
  return rowsOf(result).length > 0;
}

export async function promoteOpenThread(userId: string, contactId: string, key: string, now: Date = new Date()): Promise<PromoteOutcome> {
  const db = await getDb();
  const digest = await db.query.relationshipDigests.findFirst({ where: and(eq(relationshipDigests.contactId, contactId), eq(relationshipDigests.userId, userId)) });
  const thread = digest?.openThreads.find((t) => t.key === key);
  // A digest with no run (written before runs existed) has no batch to undo through, and an
  // undone run's batch is one Undo all can no longer reach: the profile hides Remind me for
  // both (`canRemind`), and the thread can still be dismissed.
  if (!digest || !thread || !digest.runId) return null;
  const run = await db.query.relationshipRuns.findFirst({
    where: and(eq(relationshipRuns.id, digest.runId), eq(relationshipRuns.userId, userId)),
    columns: { status: true },
  });
  if (!run || run.status === "undone") return null;
  const made = await insertReminder(userId, digest.runId, {
    contactId, title: thread.text, dueDate: tomorrow(now), excerpt: thread.excerpt,
    interactionId: thread.interactionId, hashSeed: `relationship-thread:${contactId}:${key}`, origin: "implied",
  });
  await removeThread(userId, contactId, key);
  return made;
}

export async function dismissOpenThread(userId: string, contactId: string, key: string): Promise<boolean> {
  return removeThread(userId, contactId, key);
}
