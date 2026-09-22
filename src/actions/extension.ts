"use server";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { extensionUsage } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";

/**
 * What the server knows about this user's extension: when it last made a
 * request (from any browser — the page itself can only see its own), and
 * whether their plan includes the Pro sections. Whether it's installed in
 * THIS browser is asked of the extension, client-side.
 */
export async function getExtensionStatus(): Promise<{
  lastSeenAt: string | null;
  hasExtensionPro: boolean;
}> {
  const userId = await requireUserId();
  const db = await getDb();
  const [usage, entitlements] = await Promise.all([
    db.query.extensionUsage.findFirst({
      where: eq(extensionUsage.userId, userId),
      columns: { lastSeenAt: true },
    }),
    getEntitlements(userId),
  ]);
  return {
    lastSeenAt: usage?.lastSeenAt?.toISOString() ?? null,
    hasExtensionPro: entitlements.canUseExtensionPro,
  };
}
