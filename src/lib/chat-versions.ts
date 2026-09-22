import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";

type Db = Awaited<ReturnType<typeof getDb>>;
import { chatMessages } from "@/db/schema";

/**
 * Versions for the last turn of a chat — see `AGENTS.md`'s chat plan, item 3.
 *
 * Only the LAST turn in a thread ever carries more than one version: a user row and its
 * assistant reply share a `slot`, `version` counts up within it, and `is_active` says which
 * one is shown. A new version is inserted inactive and flipped to active in ONE statement
 * once its answer is ready — neon-http has no transactions, so that single UPDATE is what
 * makes a stopped or failed regenerate leave the version it was replacing untouched.
 *
 * Editing an OLDER turn is not a third version kind: it discards every message after that
 * turn's reply (`truncateAfter`, after the caller has the person confirm) and then the turn
 * becomes the last one, so the ordinary versioning path takes it from there.
 */

export type VersionTarget = {
  slot: string;
  nextVersion: number;
  /** The user row of the version being replaced — its text is the default for "regenerate". */
  priorUserRow: { id: string; content: string; attachedContacts: Array<{ id: string; name: string }> };
  priorAssistantId: string;
};

export class NotLastTurnError extends Error {
  constructor() {
    super("That answer isn't the last one in this chat");
    this.name = "NotLastTurnError";
  }
}

/**
 * The assistant row a version request targets, verified to be the ACTIVE, LAST message in
 * its thread — the one condition that makes "another version of this" well-defined. Throws
 * `NotLastTurnError` otherwise; the caller (the route) is what decides whether that means
 * "confirm the discard" or "refuse outright".
 */
async function loadLastAssistantRow(db: Db, userId: string, threadId: string, assistantMessageId: string) {
  const [lastActive, target] = await Promise.all([
    db.query.chatMessages.findFirst({
      where: and(eq(chatMessages.threadId, threadId), eq(chatMessages.userId, userId), eq(chatMessages.isActive, true)),
      orderBy: [desc(chatMessages.createdAt)],
    }),
    db.query.chatMessages.findFirst({
      where: and(
        eq(chatMessages.id, assistantMessageId),
        eq(chatMessages.threadId, threadId),
        eq(chatMessages.userId, userId),
        eq(chatMessages.role, "assistant")
      ),
    }),
  ]);
  if (!target) throw new Error("Answer not found");
  if (!lastActive || lastActive.id !== target.id) throw new NotLastTurnError();
  return target;
}

/** How many messages sit after `assistantMessageId`'s reply — what editing that turn would discard. */
export async function discardCountAfter(
  db: Db,
  userId: string,
  threadId: string,
  assistantMessageId: string
): Promise<number> {
  const target = await db.query.chatMessages.findFirst({
    where: and(
      eq(chatMessages.id, assistantMessageId),
      eq(chatMessages.threadId, threadId),
      eq(chatMessages.userId, userId),
      eq(chatMessages.role, "assistant")
    ),
  });
  if (!target) throw new Error("Answer not found");
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(chatMessages)
    .where(and(eq(chatMessages.threadId, threadId), eq(chatMessages.userId, userId), gt(chatMessages.createdAt, target.createdAt)));
  return n;
}

/**
 * Delete every message after `assistantMessageId`'s reply. The target pair itself is left
 * exactly as it was — still active, still whatever version it already is — so if the new
 * answer that follows never lands, the thread is simply shorter, not missing its last turn.
 */
export async function truncateAfter(db: Db, userId: string, threadId: string, assistantMessageId: string): Promise<void> {
  const target = await db.query.chatMessages.findFirst({
    where: and(
      eq(chatMessages.id, assistantMessageId),
      eq(chatMessages.threadId, threadId),
      eq(chatMessages.userId, userId),
      eq(chatMessages.role, "assistant")
    ),
  });
  if (!target) throw new Error("Answer not found");
  await db
    .delete(chatMessages)
    .where(and(eq(chatMessages.threadId, threadId), eq(chatMessages.userId, userId), gt(chatMessages.createdAt, target.createdAt)));
}

/**
 * Everything needed to write a new version: the slot to write it into, the version number to
 * give it, and what the version it replaces looked like (for "regenerate", which keeps the
 * same question and attachments).
 *
 * A legacy pair (from before this feature) has `slot` null; it is given one here, in a single
 * UPDATE guarded by `slot IS NULL` so two concurrent requests cannot each mint a different
 * one — the loser's UPDATE affects zero rows and it re-reads what the winner wrote instead.
 */
export async function resolveVersionTarget(
  db: Db,
  userId: string,
  threadId: string,
  assistantMessageId: string
): Promise<VersionTarget> {
  const assistantRow = await loadLastAssistantRow(db, userId, threadId, assistantMessageId);

  const userRow = await db.query.chatMessages.findFirst({
    where: and(
      eq(chatMessages.threadId, threadId),
      eq(chatMessages.userId, userId),
      eq(chatMessages.role, "user"),
      eq(chatMessages.isActive, true)
    ),
    orderBy: [desc(chatMessages.createdAt)],
  });
  // `loadLastAssistantRow` already proved `assistantRow` is the most recent ACTIVE row in the
  // whole thread, across both roles — so the most recent active user row cannot be anything
  // but its pair. No separate createdAt comparison: two sequential inserts a moment apart can
  // still land in the same millisecond on some clocks, and `>=` would reject a perfectly good
  // pair on that tie.
  if (!userRow) {
    throw new Error("Answer not found");
  }

  let slot = assistantRow.slot;
  if (!slot) {
    const minted = randomUUID();
    const updated = await db
      .update(chatMessages)
      .set({ slot: minted, version: 1 })
      .where(and(inArray(chatMessages.id, [userRow.id, assistantRow.id]), sql`${chatMessages.slot} is null`))
      .returning(); // bare: a field selector breaks over the Db union
    if (updated.length === 2) {
      slot = minted;
    } else {
      // Lost the race (or ran twice): re-read what actually landed.
      const fresh = await db.query.chatMessages.findFirst({ where: eq(chatMessages.id, assistantRow.id) });
      if (!fresh?.slot) throw new Error("Could not version this answer");
      slot = fresh.slot;
    }
  }

  const [{ max } = { max: 1 }] = await db
    .select({ max: sql<number>`coalesce(max(${chatMessages.version}), 1)::int` })
    .from(chatMessages)
    .where(eq(chatMessages.slot, slot));

  return {
    slot,
    nextVersion: max + 1,
    priorUserRow: {
      id: userRow.id,
      content: userRow.content,
      attachedContacts: userRow.attachedContacts ?? [],
    },
    priorAssistantId: assistantRow.id,
  };
}

/** Flip exactly `userId2`/`assistantId2` active within `slot`, and everything else in it inactive — one statement. */
export async function activateVersion(
  db: Db,
  threadId: string,
  slot: string,
  userId2: string,
  assistantId2: string
): Promise<void> {
  await db
    .update(chatMessages)
    .set({ isActive: sql`(${chatMessages.id} = ${userId2} or ${chatMessages.id} = ${assistantId2})` })
    .where(and(eq(chatMessages.threadId, threadId), eq(chatMessages.slot, slot)));
}

export type VersionRow = { version: number; userMessageId: string; assistantMessageId: string };

/** Every version of `slot`, oldest first, paired up. A slot with only one version returns one row. */
export async function loadVersions(db: Db, userId: string, threadId: string, slot: string): Promise<VersionRow[]> {
  const rows = await db.query.chatMessages.findMany({
    where: and(eq(chatMessages.threadId, threadId), eq(chatMessages.userId, userId), eq(chatMessages.slot, slot)),
    orderBy: [chatMessages.version],
    columns: { id: true, role: true, version: true },
  });
  const byVersion = new Map<number, { userMessageId?: string; assistantMessageId?: string }>();
  for (const row of rows) {
    const entry = byVersion.get(row.version) ?? {};
    if (row.role === "user") entry.userMessageId = row.id;
    else entry.assistantMessageId = row.id;
    byVersion.set(row.version, entry);
  }
  return [...byVersion.entries()]
    .filter(([, v]) => v.userMessageId && v.assistantMessageId)
    .map(([version, v]) => ({ version, userMessageId: v.userMessageId!, assistantMessageId: v.assistantMessageId! }))
    .sort((a, b) => a.version - b.version);
}

/** Flip the thread to show one specific version of `slot` — used by the client's `‹ 2/3 ›` switcher. */
export async function switchVersion(
  db: Db,
  userId: string,
  threadId: string,
  slot: string,
  version: number
): Promise<VersionRow | null> {
  const versions = await loadVersions(db, userId, threadId, slot);
  const target = versions.find((v) => v.version === version);
  if (!target) return null;
  await activateVersion(db, threadId, slot, target.userMessageId, target.assistantMessageId);
  return target;
}
