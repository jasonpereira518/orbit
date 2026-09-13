import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { decryptOrNull, encrypt } from "@/lib/crypto";
import { isDemoAccount } from "@/lib/demo-account";
import { UserFacingError } from "@/lib/errors";
import { verifyApolloKey } from "@/lib/outreach/providers/apollo";
import { verifyBraveKey } from "@/lib/outreach/providers/brave";
import type { FetchLike } from "@/lib/outreach/providers/types";
import type { OutreachFundingSource } from "@/lib/outreach/types";
import { ensureUserSettings } from "@/lib/user-settings";

type Deps = { fetch?: FetchLike; sleep?: (ms: number) => Promise<void> };

export type ResearchKeyStatus = {
  brave: { saved: boolean; verifiedAt: string | null };
  apollo: { saved: boolean; verifiedAt: string | null };
  orbitSearchAvailable: boolean;
  fundingPreference: "orbit" | "personal" | null;
};

/** Verified before it is stored (the `connectLuma` pattern); a key the provider rejects is never saved. */
export async function saveBraveKey(userId: string, rawKey: string, deps: Deps = {}): Promise<{ status: "valid" | "unverified" }> {
  const key = rawKey.trim();
  if (key.length < 10 || /\s/.test(key)) throw new UserFacingError("That doesn’t look like a Brave Search key");
  const check = await verifyBraveKey(key, deps);
  if (check === "invalid") throw new UserFacingError("Brave didn’t accept that key — check it and try again");
  await ensureUserSettings(userId);
  const db = await getDb();
  const now = new Date();
  await db
    .update(userSettings)
    .set({ braveApiKeyEncrypted: encrypt(key), braveKeyVerifiedAt: check === "valid" ? now : null, updatedAt: now })
    .where(eq(userSettings.userId, userId));
  return { status: check };
}

export async function clearBraveKey(userId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(userSettings)
    .set({ braveApiKeyEncrypted: null, braveKeyVerifiedAt: null, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
}

export async function verifySavedApolloKey(
  userId: string,
  deps: Deps = {}
): Promise<"valid" | "invalid" | "unverified" | "missing"> {
  const db = await getDb();
  const [row] = await db
    .select({ apollo: userSettings.apolloApiKeyEncrypted })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  const key = decryptOrNull(row?.apollo);
  if (!key) return "missing";
  const check = await verifyApolloKey(key, deps);
  if (check !== "unverified") {
    await db
      .update(userSettings)
      .set({ apolloKeyVerifiedAt: check === "valid" ? new Date() : null })
      .where(eq(userSettings.userId, userId));
  }
  return check;
}

export async function getResearchKeyStatus(userId: string): Promise<ResearchKeyStatus> {
  const settings = await ensureUserSettings(userId);
  const db = await getDb();
  const [row] = await db
    .select({
      brave: userSettings.braveApiKeyEncrypted,
      braveAt: userSettings.braveKeyVerifiedAt,
      apollo: userSettings.apolloApiKeyEncrypted,
      apolloAt: userSettings.apolloKeyVerifiedAt,
      pref: userSettings.outreachFundingPreference,
    })
    .from(userSettings)
    .where(eq(userSettings.userId, settings.userId));
  return {
    brave: { saved: Boolean(row?.brave), verifiedAt: row?.braveAt?.toISOString() ?? null },
    apollo: { saved: Boolean(row?.apollo), verifiedAt: row?.apolloAt?.toISOString() ?? null },
    orbitSearchAvailable: Boolean(process.env.BRAVE_SEARCH_API_KEY?.trim()) || isDemoAccount(userId),
    fundingPreference: row?.pref ?? null,
  };
}

export async function setFundingPreference(userId: string, pref: OutreachFundingSource): Promise<void> {
  const db = await getDb();
  await db.update(userSettings).set({ outreachFundingPreference: pref }).where(eq(userSettings.userId, userId));
}
