import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { cleanSignature } from "@/lib/email/signature";

/** Read directly, not through the cached `ensureUserSettings`, so a save shows at once. */
export async function loadEmailSettings(userId: string): Promise<{ signature: string | null }> {
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { emailSignatureText: true },
  });
  return { signature: row?.emailSignatureText ?? null };
}

export async function saveEmailSignature(userId: string, raw: string): Promise<string | null> {
  const signature = cleanSignature(raw);
  const db = await getDb();
  await db
    .insert(userSettings)
    .values({ userId, emailSignatureText: signature })
    .onConflictDoUpdate({ target: userSettings.userId, set: { emailSignatureText: signature } });
  return signature;
}
