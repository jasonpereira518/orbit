import { getCreditBalance, listCreditLedger } from "@/lib/outreach/credits/ledger";
import { canUseOutreachNext } from "@/lib/outreach/gate";
import { getResearchKeyStatus, type ResearchKeyStatus } from "@/lib/outreach/keys";

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

/**
 * Settings' research section. `{ enabled: false }` means Settings simply omits it — for anyone
 * who fails the check the key and credit mutations behind it use (plan + page surface + gate),
 * checked BEFORE anything is read: `getCreditBalance` creates the credit account on first
 * read, and merely viewing Settings must not open one for a free user.
 */
export async function loadResearchSettings(userId: string): Promise<ResearchSettings> {
  if (!(await canUseOutreachNext(userId))) return { enabled: false };
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
