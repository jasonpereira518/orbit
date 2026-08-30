"use server";

import { eq } from "drizzle-orm";
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

export async function addStartupExpenseAction(input: {
  category: string;
  amountUsd: number;
  incurredAt: string;
  note?: string;
}): Promise<{ ok: true }> {
  await requireAdminUserId();
  const db = await getDb();

  await db.insert(startupExpenses).values({
    category: input.category,
    amountUsd: input.amountUsd,
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
    balanceUsd: input.balanceUsd,
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
    channel: input.channel,
    amountUsd: input.amountUsd,
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

  await db
    .insert(userSettings)
    .values({ userId: adminUserId, estimatedMonthlyChurnPct: input.monthlyChurnPct })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { estimatedMonthlyChurnPct: input.monthlyChurnPct, updatedAt: new Date() },
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
    name: input.name,
    targetUsd: input.targetUsd,
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
    name: input.name,
    amountUsd: input.amountUsd,
    committedAt: new Date(input.committedAt),
  });

  revalidatePath("/admin/yc/fundraising");
  return { ok: true };
}
