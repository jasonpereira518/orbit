"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  acquisitionSpend,
  cashSnapshots,
  fundraisingInvestors,
  fundraisingRounds,
  startupExpenses,
  userSettings,
} from "@/db/schema";
import { requireAdminUserId } from "@/lib/admin";

/**
 * Every write below used to trust its input outright — fine for the forms, which already
 * check client-side, but every export here is a Server Action and therefore reachable by a
 * direct POST that skips the form entirely (the same reason every export re-asserts
 * `requireAdminUserId()`). A garbage value written here doesn't fail loudly; it just quietly
 * corrupts burn, CAC, LTV, or fundraising-progress math the next time someone reads it.
 */
function requirePositiveAmount(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 100_000_000) {
    throw new Error(`${label} must be a number greater than zero.`);
  }
  return value;
}

function requireNonNegativeAmount(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 100_000_000) {
    throw new Error(`${label} must be zero or a positive number.`);
  }
  return value;
}

function requirePercent(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${label} must be a percentage between 0 and 100.`);
  }
  return value;
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
}

export async function addStartupExpenseAction(input: {
  category: string;
  amountUsd: number;
  incurredAt: string;
  note?: string;
}): Promise<{ ok: true }> {
  await requireAdminUserId();
  const db = await getDb();

  await db.insert(startupExpenses).values({
    category: requireNonEmpty(input.category, "Category"),
    amountUsd: requirePositiveAmount(input.amountUsd, "Amount"),
    incurredAt: new Date(input.incurredAt),
    note: input.note?.trim() || null,
  });

  revalidatePath("/admin/yc/runway");
  return { ok: true };
}

export async function setCashSnapshotAction(input: {
  balanceUsd: number;
  asOf: string;
}): Promise<{ ok: true }> {
  await requireAdminUserId();
  const db = await getDb();

  await db.insert(cashSnapshots).values({
    balanceUsd: requireNonNegativeAmount(input.balanceUsd, "Cash balance"),
    asOf: new Date(input.asOf),
  });

  revalidatePath("/admin/yc/runway");
  return { ok: true };
}

export async function addAcquisitionSpendAction(input: {
  channel: string;
  amountUsd: number;
  periodStart: string;
  periodEnd: string;
}): Promise<{ ok: true }> {
  await requireAdminUserId();
  const db = await getDb();

  await db.insert(acquisitionSpend).values({
    channel: requireNonEmpty(input.channel, "Channel"),
    amountUsd: requirePositiveAmount(input.amountUsd, "Amount"),
    periodStart: new Date(input.periodStart),
    periodEnd: new Date(input.periodEnd),
  });

  revalidatePath("/admin/yc/economics");
  return { ok: true };
}

export async function setEstimatedChurnAction(input: {
  monthlyChurnPct: number;
}): Promise<{ ok: true }> {
  const adminUserId = await requireAdminUserId();
  const db = await getDb();
  const monthlyChurnPct = requirePercent(input.monthlyChurnPct, "Estimated monthly churn");

  await db
    .insert(userSettings)
    .values({ userId: adminUserId, estimatedMonthlyChurnPct: monthlyChurnPct })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { estimatedMonthlyChurnPct: monthlyChurnPct, updatedAt: new Date() },
    });

  revalidatePath("/admin/yc/economics");
  return { ok: true };
}

export async function createFundraisingRoundAction(input: {
  name: string;
  targetUsd: number;
}): Promise<{ ok: true }> {
  await requireAdminUserId();
  const db = await getDb();

  await db.insert(fundraisingRounds).values({
    name: requireNonEmpty(input.name, "Round name"),
    targetUsd: requirePositiveAmount(input.targetUsd, "Target"),
  });

  revalidatePath("/admin/yc/fundraising");
  return { ok: true };
}

export async function addFundraisingInvestorAction(input: {
  roundId: string;
  name: string;
  amountUsd: number;
  committedAt: string;
}): Promise<{ ok: true }> {
  await requireAdminUserId();
  const db = await getDb();

  await db.insert(fundraisingInvestors).values({
    roundId: input.roundId,
    name: requireNonEmpty(input.name, "Investor"),
    amountUsd: requirePositiveAmount(input.amountUsd, "Amount"),
    committedAt: new Date(input.committedAt),
  });

  revalidatePath("/admin/yc/fundraising");
  return { ok: true };
}
