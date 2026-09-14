import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  outreachCampaigns,
  outreachMessages,
  outreachProspects,
  outreachJobs,
  outreachCreditAccounts,
  outreachCreditLedger,
} from "@/db/schema";
import { getEntitlements } from "@/lib/entitlements";
import { fundingWindow } from "./policy";
import type { JobPayload } from "./types";

export function enabled() {
  return process.env.OUTREACH_V2_ENABLED === "1";
}
export async function requireAccess(userId: string) {
  if (!enabled()) throw new Error("The Outreach preview is not enabled.");
  if (!(await getEntitlements(userId)).canUseOutreach)
    throw new Error("Outreach requires Pro or Lifetime.");
}
export async function campaignFor(userId: string, id: string) {
  const db = await getDb();
  const c = await db.query.outreachCampaigns.findFirst({
    where: and(
      eq(outreachCampaigns.id, id),
      eq(outreachCampaigns.userId, userId),
    ),
  });
  if (!c) throw new Error("Campaign not found.");
  return c;
}
export async function messageFor(userId: string, id: string) {
  const db = await getDb();
  const m = await db.query.outreachMessages.findFirst({
    where: eq(outreachMessages.id, id),
  });
  if (!m) throw new Error("Message not found.");
  const p = await db.query.outreachProspects.findFirst({
    where: eq(outreachProspects.id, m.prospectId),
  });
  if (!p) throw new Error("Person not found.");
  return {
    message: m,
    prospect: p,
    campaign: await campaignFor(userId, p.campaignId),
  };
}
export async function enqueue(
  userId: string,
  campaignId: string,
  kind: string,
  key: string,
  payload: JobPayload,
) {
  const db = await getDb();
  await campaignFor(userId, campaignId);
  const [job] = await db
    .insert(outreachJobs)
    .values({ userId, campaignId, kind, key, payload })
    .onConflictDoUpdate({
      target: [outreachJobs.userId, outreachJobs.key],
      set: { status: "queued", availableAt: new Date(), error: null },
      where: sql`${outreachJobs.status}='failed' AND ${outreachJobs.kind} NOT IN ('send','browser_send')`,
    })
    .returning();
  return job;
}
export async function claimJob(
  kinds: string[],
  userId?: string,
  campaignId?: string,
) {
  const db = await getDb();
  // Expired sends must never become retryable: the provider may already have sent them.
  await db.execute(sql`UPDATE outreach_jobs SET status = 'needs_verification', error = 'Execution interrupted. Verify the original send before retrying.'
    WHERE status = 'running' AND lease_until < now() AND kind IN ('send','browser_send')`);
  const token = randomUUID();
  const result =
    await db.execute(sql`UPDATE outreach_jobs SET status='running', lease_token=${token}, lease_until=now()+interval '5 minutes', attempts=attempts+1, updated_at=now()
    WHERE id=(SELECT j.id FROM outreach_jobs j JOIN outreach_campaigns c ON c.id=j.campaign_id
      WHERE j.kind IN (${sql.join(
        kinds.map((k) => sql`${k}`),
        sql`,`,
      )}) AND c.paused=false AND c.version=2
      AND (j.status='queued' OR (j.status='running' AND j.kind NOT IN ('send','browser_send') AND j.lease_until<now()))
      AND j.available_at<=now() ${userId ? sql`AND j.user_id=${userId}` : sql``} ${campaignId ? sql`AND j.campaign_id=${campaignId}` : sql``}
      ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1) RETURNING id`);
  const id = (result.rows[0] as { id?: string } | undefined)?.id;
  return id
    ? db.query.outreachJobs.findFirst({
        where: and(eq(outreachJobs.id, id), eq(outreachJobs.leaseToken, token)),
      })
    : undefined;
}
export async function finishJob(
  id: string,
  token: string,
  status: string,
  result?: Record<string, unknown>,
  error?: string,
) {
  const db = await getDb();
  const [row] = await db
    .update(outreachJobs)
    .set({ status, result, error: error ?? null, updatedAt: new Date() })
    .where(
      and(
        eq(outreachJobs.id, id),
        eq(outreachJobs.leaseToken, token),
        eq(outreachJobs.status, "running"),
      ),
    )
    .returning();
  return row;
}
export async function allowance(userId: string) {
  const ent = await getEntitlements(userId);
  const period = fundingWindow(ent.plan);
  const raw =
    ent.plan === "lifetime"
      ? (process.env.OUTREACH_LIFETIME_CREDITS ?? "100")
      : (process.env.OUTREACH_PRO_CREDITS ?? "250");
  const limit = ent.canUseOutreach
    ? Math.max(0, Math.min(10000, Number(raw) || 0))
    : 0;
  const db = await getDb();
  const account = await db.query.outreachCreditAccounts.findFirst({
    where: and(
      eq(outreachCreditAccounts.userId, userId),
      eq(outreachCreditAccounts.period, period),
    ),
  });
  return {
    period,
    limit,
    used: account?.used ?? 0,
    searches: account?.searches ?? 0,
    remaining: Math.max(0, limit - (account?.used ?? 0)),
  };
}
export async function reserveResearch(
  userId: string,
  key: string,
  funding: "hosted" | "personal",
) {
  const db = await getDb();
  const a = await allowance(userId);
  await db
    .insert(outreachCreditAccounts)
    .values({ userId, period: a.period })
    .onConflictDoNothing();
  // Lock the per-user account before checking the ledger, so concurrent reservations
  // for the same key neither overspend nor consume two credits. One SQL transaction.
  const result = await db.execute(sql`WITH account AS MATERIALIZED (
    SELECT * FROM outreach_credit_accounts WHERE user_id=${userId} AND period=${a.period} FOR UPDATE
  ), inserted AS (
    INSERT INTO outreach_credit_ledger(user_id,period,key,funding)
    SELECT ${userId},${a.period},${key},${funding} FROM account
    WHERE (${funding}='personal' OR used<${a.limit})
    ON CONFLICT(user_id,key) DO NOTHING RETURNING id
  ), charged AS (
    UPDATE outreach_credit_accounts SET used=used+(CASE WHEN ${funding}='hosted' THEN 1 ELSE 0 END)
    WHERE user_id=${userId} AND period=${a.period} AND EXISTS(SELECT 1 FROM inserted) RETURNING id
  ) SELECT id FROM inserted`);
  if (result.rows.length) return true;
  const existing = await db.query.outreachCreditLedger.findFirst({
    where: and(
      eq(outreachCreditLedger.userId, userId),
      eq(outreachCreditLedger.key, key),
    ),
  });
  return Boolean(existing && existing.status !== "released");
}
export async function consumeResearch(
  userId: string,
  key: string,
  calls: number,
) {
  const db = await getDb();
  const [claimed] = await db
    .update(outreachCreditLedger)
    .set({
      status: "consumed",
      providerCalls: sql`${outreachCreditLedger.providerCalls}+${calls}`,
      providerCostMicros: process.env.OUTREACH_RESEARCH_CALL_COST_MICROS
        ? sql`COALESCE(${outreachCreditLedger.providerCostMicros},0)+${Math.round(calls * Number(process.env.OUTREACH_RESEARCH_CALL_COST_MICROS))}`
        : null,
    })
    .where(
      and(
        eq(outreachCreditLedger.userId, userId),
        eq(outreachCreditLedger.key, key),
        sql`${outreachCreditLedger.status} IN ('reserved','consumed')`,
        sql`${outreachCreditLedger.providerCalls}+${calls}<=2`,
      ),
    )
    .returning();
  return Boolean(claimed);
}
export async function releaseResearch(userId: string, keys: string[]) {
  if (!keys.length) return;
  const db = await getDb();
  await db.execute(sql`WITH released AS (
    UPDATE outreach_credit_ledger SET status='released' WHERE user_id=${userId} AND key IN (${sql.join(
      keys.map((k) => sql`${k}`),
      sql`,`,
    )}) AND status='reserved' RETURNING period,funding
  ) UPDATE outreach_credit_accounts a SET used=GREATEST(0,a.used-r.n) FROM
    (SELECT period,count(*)::int n FROM released WHERE funding='hosted' GROUP BY period) r WHERE a.user_id=${userId} AND a.period=r.period`);
}
export async function cancelQueued(userId: string, campaignId: string) {
  await campaignFor(userId, campaignId);
  const db = await getDb();
  const jobs = await db
    .update(outreachJobs)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(outreachJobs.campaignId, campaignId),
        eq(outreachJobs.userId, userId),
        eq(outreachJobs.status, "queued"),
      ),
    )
    .returning();
  await releaseResearch(
    userId,
    jobs.filter((j) => j.kind === "research").map((j) => j.key),
  );
  const ids = jobs
    .map((j) => j.payload.messageId)
    .filter((id): id is string => Boolean(id));
  if (ids.length)
    await db
      .update(outreachMessages)
      .set({ executionStatus: "cancelled" })
      .where(inArray(outreachMessages.id, ids));
}
