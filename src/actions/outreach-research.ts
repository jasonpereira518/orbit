"use server";

import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth";
import { asActionResult, type ActionResult } from "@/lib/errors";
import { getCreditBalance, listCreditLedger } from "@/lib/outreach/credits/ledger";
import { isOutreachNextEnabled, requireOutreachNextUser } from "@/lib/outreach/gate";
import {
  clearBraveKey,
  getResearchKeyStatus,
  saveBraveKey,
  verifySavedApolloKey,
  type ResearchKeyStatus,
} from "@/lib/outreach/keys";

export type ResearchSettings =
  | { enabled: false }
  | {
      enabled: true;
      keys: ResearchKeyStatus;
      credits: {
        monthlyAllowance: number;
        monthlyAvailable: number;
        lifetimeAvailable: number;
        total: number;
        held: number;
        periodEnd: string;
      };
      ledger: Array<{
        id: string;
        entryType: string;
        amountMonthly: number;
        amountLifetime: number;
        note: string | null;
        createdAt: string;
      }>;
    };

/** Read-only; returns `{ enabled: false }` outside the gate so Settings simply omits the section. */
export async function getResearchSettings(): Promise<ResearchSettings> {
  const userId = await requireUserId();
  if (!(await isOutreachNextEnabled(userId))) return { enabled: false };
  const [keys, balance, ledger] = await Promise.all([
    getResearchKeyStatus(userId),
    getCreditBalance(userId),
    listCreditLedger(userId, 15),
  ]);
  return {
    enabled: true,
    keys,
    credits: {
      monthlyAllowance: balance.monthlyAllowance,
      monthlyAvailable: balance.monthlyAvailable,
      lifetimeAvailable: balance.lifetimeAvailable,
      total: balance.total,
      held: balance.held,
      periodEnd: balance.periodEnd.toISOString(),
    },
    ledger: ledger.map((row) => ({
      id: row.id,
      entryType: row.entryType,
      amountMonthly: row.amountMonthly,
      amountLifetime: row.amountLifetime,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

export async function saveBraveKeyAction(key: string): Promise<ActionResult<{ status: "valid" | "unverified" }>> {
  return asActionResult(async () => {
    const userId = await requireOutreachNextUser();
    const result = await saveBraveKey(userId, key);
    revalidatePath("/settings");
    return result;
  });
}

export async function clearBraveKeyAction(): Promise<ActionResult<null>> {
  return asActionResult(async () => {
    const userId = await requireOutreachNextUser();
    await clearBraveKey(userId);
    revalidatePath("/settings");
    return null;
  });
}

export async function verifyApolloKeyAction(): Promise<
  ActionResult<{ status: "valid" | "invalid" | "unverified" | "missing" }>
> {
  return asActionResult(async () => {
    const userId = await requireOutreachNextUser();
    return { status: await verifySavedApolloKey(userId) };
  });
}
