import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { normalizeSenderBio } from "@/lib/sender-profile";

/**
 * Read the user's own description of themselves.
 *
 * Best-effort by design, and the reason is the same one that made the sign-off lookup in
 * `follow-up-drafts.ts` best-effort: a draft is worth more than the context that would have
 * improved it. A failed read here returns null and the prompt simply omits the block.
 */
export async function loadSenderBio(userId: string): Promise<string | null> {
  try {
    const db = await getDb();
    const row = await db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
      columns: { senderBio: true },
    });
    return normalizeSenderBio(row?.senderBio);
  } catch {
    return null;
  }
}

/**
 * The user's full name as Orbit's mirror holds it ("Jason Pereira"), for an email sign-off.
 * Read from `user_settings` rather than Clerk so it works with no request in flight (a
 * sequence's follow-ups, Radar overnight). Best-effort like the bio: null drops the sign-off.
 */
export async function loadSenderName(userId: string): Promise<string | null> {
  try {
    const db = await getDb();
    const row = await db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
      columns: { firstName: true, lastName: true },
    });
    const name = [row?.firstName, row?.lastName].map((p) => p?.trim()).filter(Boolean).join(" ");
    return name || null;
  } catch {
    return null;
  }
}
