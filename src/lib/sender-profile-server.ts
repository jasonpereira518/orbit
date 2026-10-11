import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { normalizeSearchProfile, normalizeSenderBio, type SearchProfile } from "@/lib/sender-profile";

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

/** Target role, graduation year and search status, for the draft's sender line. All-null on error, like the bio. */
export async function loadSearchProfile(userId: string): Promise<SearchProfile> {
  try {
    const db = await getDb();
    const row = await db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
      columns: { targetRole: true, graduationYear: true, searchStatus: true },
    });
    return normalizeSearchProfile(row);
  } catch {
    return normalizeSearchProfile(null);
  }
}
