import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { sanitizeWritingInstructions } from "@/lib/writing-instructions";

/**
 * The user's writing notes, read straight off the row.
 *
 * A direct column read rather than `ensureUserSettings`: that helper is wrapped in React's
 * request-scoped `cache()`, so a value saved earlier in the same request would come back
 * stale — and it creates the row, which a read has no business doing. A missing row is
 * simply "no preferences".
 */
export async function loadWritingInstructions(userId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { writingInstructions: true },
  });
  return sanitizeWritingInstructions(row?.writingInstructions);
}

/**
 * Store the notes, cleaned and capped, or clear them (null, empty and whitespace all mean
 * "none"). Returns what was stored so the client can show the cleaned text back.
 *
 * An upsert, because a user who never opened Settings has no row yet and this box is
 * reachable from chat.
 */
export async function saveWritingInstructionsFor(
  userId: string,
  text: string | null | undefined
): Promise<string | null> {
  const cleaned = sanitizeWritingInstructions(text);
  const db = await getDb();
  await db
    .insert(userSettings)
    .values({ userId, writingInstructions: cleaned })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { writingInstructions: cleaned },
    });
  return cleaned;
}
