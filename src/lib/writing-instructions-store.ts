import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { sanitizeWritingInstructions, withStyleProfile } from "@/lib/writing-instructions";

/**
 * What every draft is told about how the user writes: their own notes, then the style learned
 * from their sent mail (`withStyleProfile`). The notes box itself reads
 * `loadOwnWritingInstructions`, so the learned part never shows up as text they typed.
 *
 * Read straight off the row.
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
    columns: { writingInstructions: true, writingStyleProfile: true },
  });
  return writingInstructionsFromRow(row);
}

/** Only what the user typed into the notes box. */
export async function loadOwnWritingInstructions(userId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { writingInstructions: true },
  });
  return sanitizeWritingInstructions(row?.writingInstructions);
}

/**
 * The same answer from a `user_settings` row the caller already read IN THIS REQUEST — the
 * one `/api/chat` resolved its AI access from — so the notes cost no second read. Only for a
 * row read after any save this request made (see above for why a stale row is wrong here).
 */
export function writingInstructionsFromRow(
  row: { writingInstructions?: string | null; writingStyleProfile?: string | null } | null | undefined
): string | null {
  return withStyleProfile(row?.writingInstructions, row?.writingStyleProfile);
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
