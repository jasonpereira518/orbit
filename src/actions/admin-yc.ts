"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  acquisitionSpend,
  cashSnapshots,
  fundraisingInvestors,
  fundraisingRounds,
  nonDilutiveFunding,
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Shape-check an id before it reaches a query. Without this a malformed value reaches
 * Postgres and comes back as a raw `invalid input syntax for type uuid`, which is a
 * database error surfacing as a page crash rather than a message anyone can act on.
 */
function requireUuid(value: string, label: string): string {
  if (!UUID_RE.test(value ?? "")) throw new Error(`${label} is not a valid id.`);
  return value;
}

/**
 * Parse a date the form supplied. Rejects unparseable strings, anything before 2000 (a
 * mistyped year, not a real commitment) and anything more than a year out — a scheduled
 * wire is legitimate, a typo'd `2206` is not.
 */
function requireDate(value: string, label: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} is not a valid date.`);
  const year = parsed.getUTCFullYear();
  if (year < 2000) throw new Error(`${label} looks mistyped — it is before 2000.`);
  if (parsed.getTime() > Date.now() + 365 * 24 * 60 * 60 * 1000) {
    throw new Error(`${label} is more than a year in the future.`);
  }
  return parsed;
}

function requireOptionalDate(value: string | undefined | null, label: string): Date | null {
  if (!value) return null;
  return requireDate(value, label);
}

function requireOneOf<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string
): T {
  if (!allowed.includes(value as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

const NON_DILUTIVE_KINDS = ["credit", "grant", "prize", "accelerator", "loan", "other"] as const;
const NON_DILUTIVE_FORMS = ["cash", "in_kind"] as const;

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

/**
 * Confirm a round exists before writing a child row against it.
 *
 * The FK would catch a bad id anyway, but only as a raw constraint violation from the
 * driver. Every other guard in this file exists to turn a direct POST into a sentence;
 * this one does the same for the id.
 */
async function requireRound(roundId: string) {
  const db = await getDb();
  const round = await db.query.fundraisingRounds.findFirst({
    where: eq(fundraisingRounds.id, requireUuid(roundId, "Round")),
  });
  if (!round) throw new Error("That round no longer exists.");
  return round;
}

export async function addFundraisingInvestorAction(input: {
  roundId: string;
  name: string;
  amountUsd: number;
  committedAt: string;
  receivedAt?: string | null;
  note?: string;
}): Promise<{ ok: true }> {
  await requireAdminUserId();
  const round = await requireRound(input.roundId);
  const db = await getDb();

  await db.insert(fundraisingInvestors).values({
    roundId: round.id,
    name: requireNonEmpty(input.name, "Investor"),
    amountUsd: requirePositiveAmount(input.amountUsd, "Amount"),
    committedAt: requireDate(input.committedAt, "Committed"),
    receivedAt: requireOptionalDate(input.receivedAt, "Received"),
    note: input.note?.trim() || null,
  });

  revalidatePath("/admin/yc/fundraising");
  return { ok: true };
}

/**
 * Mark a commitment as actually wired, or (with a null date) walk that back.
 *
 * `receivedAt` is what separates "In the bank" from "Committed, not received" on the
 * Funding page — before this action existed both columns were the same number wearing
 * two labels.
 */
export async function markInvestorReceivedAction(input: {
  investorId: string;
  receivedAt: string | null;
}): Promise<{ ok: true }> {
  await requireAdminUserId();
  const db = await getDb();

  await db
    .update(fundraisingInvestors)
    .set({ receivedAt: requireOptionalDate(input.receivedAt, "Received") })
    .where(eq(fundraisingInvestors.id, requireUuid(input.investorId, "Commitment")));

  revalidatePath("/admin/yc/fundraising");
  return { ok: true };
}

export async function deleteFundraisingInvestorAction(input: {
  investorId: string;
}): Promise<{ ok: true }> {
  await requireAdminUserId();
  const db = await getDb();

  await db
    .delete(fundraisingInvestors)
    .where(eq(fundraisingInvestors.id, requireUuid(input.investorId, "Commitment")));

  revalidatePath("/admin/yc/fundraising");
  return { ok: true };
}

/**
 * Close a round, or reopen one closed by mistake.
 *
 * `status` and `closed_at` have existed since the table was created and were written by
 * nothing — every round read as permanently "open", and the page printed that dead
 * literal in its own title.
 */
export async function setFundraisingRoundStatusAction(input: {
  roundId: string;
  status: "open" | "closed";
}): Promise<{ ok: true }> {
  await requireAdminUserId();
  const round = await requireRound(input.roundId);
  const status = requireOneOf(input.status, ["open", "closed"] as const, "Status");
  const db = await getDb();

  await db
    .update(fundraisingRounds)
    .set({ status, closedAt: status === "closed" ? new Date() : null })
    .where(eq(fundraisingRounds.id, round.id));

  revalidatePath("/admin/yc/fundraising");
  return { ok: true };
}

/**
 * Record money that cost no equity: a grant, a prize, cloud or model credits, accelerator
 * cash, or a loan.
 *
 * `form` is validated separately from `kind` because it is the field that changes the
 * arithmetic — an `in_kind` row never enters the cash total. See the schema comment on
 * `nonDilutiveFunding` for why the two are not one column.
 */
export async function addNonDilutiveFundingAction(input: {
  source: string;
  kind: string;
  form: string;
  amountUsd: number;
  awardedAt: string;
  receivedAt?: string | null;
  expiresAt?: string | null;
  repayable?: boolean;
  note?: string;
}): Promise<{ ok: true }> {
  await requireAdminUserId();
  const db = await getDb();

  const awardedAt = requireDate(input.awardedAt, "Awarded");
  const expiresAt = requireOptionalDate(input.expiresAt, "Expires");
  if (expiresAt && expiresAt.getTime() <= awardedAt.getTime()) {
    throw new Error("Expiry must be after the award date.");
  }

  await db.insert(nonDilutiveFunding).values({
    source: requireNonEmpty(input.source, "Source"),
    kind: requireOneOf(input.kind, NON_DILUTIVE_KINDS, "Kind"),
    form: requireOneOf(input.form, NON_DILUTIVE_FORMS, "Form"),
    repayable: input.repayable === true,
    amountUsd: requirePositiveAmount(input.amountUsd, "Amount"),
    awardedAt,
    receivedAt: requireOptionalDate(input.receivedAt, "Received"),
    expiresAt,
    note: input.note?.trim() || null,
  });

  revalidatePath("/admin/yc/fundraising");
  return { ok: true };
}

/**
 * Record repayment against a loan or revenue-based financing.
 *
 * Absolute rather than incremental — the operator types what has been repaid in total, so
 * a double-submit corrects the figure instead of doubling it.
 */
export async function recordLoanRepaymentAction(input: {
  id: string;
  repaidUsd: number;
}): Promise<{ ok: true }> {
  await requireAdminUserId();
  const db = await getDb();
  const id = requireUuid(input.id, "Funding");

  const row = await db.query.nonDilutiveFunding.findFirst({
    where: eq(nonDilutiveFunding.id, id),
  });
  if (!row) throw new Error("That funding record no longer exists.");
  if (!row.repayable) throw new Error("That funding is not repayable.");

  const repaidUsd = requireNonNegativeAmount(input.repaidUsd, "Repaid");
  if (repaidUsd > row.amountUsd) {
    throw new Error("Repaid cannot exceed the amount borrowed.");
  }

  await db
    .update(nonDilutiveFunding)
    .set({ repaidUsd })
    .where(eq(nonDilutiveFunding.id, id));

  revalidatePath("/admin/yc/fundraising");
  return { ok: true };
}

export async function deleteNonDilutiveFundingAction(input: {
  id: string;
}): Promise<{ ok: true }> {
  await requireAdminUserId();
  const db = await getDb();

  await db
    .delete(nonDilutiveFunding)
    .where(eq(nonDilutiveFunding.id, requireUuid(input.id, "Funding")));

  revalidatePath("/admin/yc/fundraising");
  return { ok: true };
}
