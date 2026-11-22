import { and, count, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { chatMemories } from "@/db/schema";
import { UserFacingError } from "@/lib/errors";
import { MEMORIES_MAX, MEMORY_MAX_CHARS, cleanMemoryText } from "@/lib/chat-memory-text";

/**
 * Things the person asked Orbit to keep in mind across chats ("I'm raising a seed round",
 * "keep intros to three sentences").
 *
 * WHO MAY WRITE ONE. This text goes into every later chat prompt, which makes it the same
 * kind of thing as the writing instructions: a model that could set it freely could be
 * talked into planting a standing instruction by a poisoned note or web page. So there are
 * exactly two ways in, and both end in the person's own click:
 *   - they add it themselves, in the chat Context sheet;
 *   - the model PROPOSES one (`remember` in `@/lib/tools/chat-writes-features`), which is a
 *     `confirm` card and therefore never auto-applied, whatever the auto-apply setting.
 * And on the way back out it is fenced as data in the prompt, never as instructions.
 *
 * Every statement is scoped by user id.
 */
export type ChatMemory = { id: string; text: string; createdAt: Date };

export async function listMemories(userId: string): Promise<ChatMemory[]> {
  const db = await getDb();
  return db
    .select({ id: chatMemories.id, text: chatMemories.text, createdAt: chatMemories.createdAt })
    .from(chatMemories)
    .where(eq(chatMemories.userId, userId))
    .orderBy(desc(chatMemories.createdAt))
    .limit(MEMORIES_MAX);
}

export async function addMemory(userId: string, raw: string, sourceThreadId: string | null = null): Promise<ChatMemory> {
  const text = cleanMemoryText(raw);
  if (!text) throw new UserFacingError("There’s nothing to remember there");
  const db = await getDb();
  const [row] = await db.select({ n: count() }).from(chatMemories).where(eq(chatMemories.userId, userId));
  if ((row?.n ?? 0) >= MEMORIES_MAX) {
    throw new UserFacingError(`Orbit is already remembering ${MEMORIES_MAX} things — remove one first`);
  }
  const [saved] = await db.insert(chatMemories).values({ userId, text, sourceThreadId }).returning();
  return { id: saved.id, text: saved.text, createdAt: saved.createdAt };
}

/** True when a memory of this person's was removed. */
export async function deleteMemory(userId: string, id: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .delete(chatMemories)
    .where(and(eq(chatMemories.id, id), eq(chatMemories.userId, userId)))
    .returning();
  return rows.length > 0;
}

export { MEMORIES_MAX, MEMORY_MAX_CHARS };
