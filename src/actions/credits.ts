"use server";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { getCreditBalance, type CreditBalance } from "@/lib/credits/ledger";
import { equivalentsFor, measuredActionCosts, type ActionKey } from "@/lib/credits/equivalents";
import { PLAN_CONFIG, type Plan } from "@/lib/plans/plan-config";

export type CreditsOverview = {
  plan: Plan;
  monthlyCredits: number;
  balance: CreditBalance;
  equivalents: Array<{ action: ActionKey; count: number }>;
  /** Show the one-time "two packs plus Pro is about the price of Max" prompt now. */
  showMaxNudge: boolean;
  /** Whether Orbit emails at 80% and 100% of the monthly credits. */
  creditEmailEnabled: boolean;
};

/**
 * The credits card's data: allowance and pack credits remaining, the reset date, plain
 * equivalents from measured cost, and whether the Max nudge is due. Null for plans without
 * included AI (Free and Lifetime) — unless the account holds frozen pack credits, which the
 * card still reports so nobody thinks money vanished.
 */
export async function getCreditsOverview(): Promise<CreditsOverview | null> {
  const userId = await requireUserId();
  const { plan } = await getEntitlements(userId);
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
  const balance = await getCreditBalance(userId, plan, row);
  const monthlyCredits = PLAN_CONFIG[plan].monthlyCredits ?? 0;
  if (!monthlyCredits && balance.packRemaining === 0) return null;
  const equivalents = monthlyCredits ? equivalentsFor(balance.spendable, await measuredActionCosts()) : [];
  return {
    plan,
    monthlyCredits,
    balance,
    equivalents,
    showMaxNudge: plan === "orbit" && balance.packsThisCycle >= 2 && !row?.maxNudgeSeenAt,
    creditEmailEnabled: (row?.creditEmailEnabled ?? 1) === 1,
  };
}

/**
 * Whole credits a Free account can still spend, for the ask bar's low-credit line. Null for
 * any other plan, or when the account runs on its own key (credits are not what it spends).
 */
export async function getFreeCreditsLeft(): Promise<number | null> {
  const userId = await requireUserId();
  const { plan } = await getEntitlements(userId);
  if (plan !== "free") return null;
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
  const ownKey = Boolean(row?.geminiApiKeyEncrypted || row?.openaiApiKeyEncrypted || row?.anthropicApiKeyEncrypted || row?.openrouterApiKeyEncrypted);
  if (ownKey && row?.aiKeyPreference !== "included") return null;
  const balance = await getCreditBalance(userId, plan, row, new Date(), { ensure: false });
  return Math.floor(balance.spendable / 10_000);
}

/** Which key runs by default when the account has both. Pro and Max only. */
export async function setAiKeyPreference(preference: "included" | "own"): Promise<{ ok: boolean }> {
  const userId = await requireUserId();
  if (preference !== "included" && preference !== "own") return { ok: false };
  const { canUseHostedAi } = await getEntitlements(userId);
  if (!canUseHostedAi) return { ok: false };
  const db = await getDb();
  await db.update(userSettings).set({ aiKeyPreference: preference, updatedAt: new Date() }).where(eq(userSettings.userId, userId));
  return { ok: true };
}

/** The Max nudge is shown once, ever. */
export async function dismissMaxNudge(): Promise<void> {
  const userId = await requireUserId();
  const db = await getDb();
  await db.update(userSettings).set({ maxNudgeSeenAt: new Date() }).where(eq(userSettings.userId, userId));
}

/** The emails at 80% and 100% of the monthly credits: on or off. The in-app notices stay either way. */
export async function setCreditEmailEnabled(enabled: boolean): Promise<{ ok: boolean }> {
  const userId = await requireUserId();
  const db = await getDb();
  await db
    .update(userSettings)
    .set({ creditEmailEnabled: enabled === true ? 1 : 0, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
  return { ok: true };
}
