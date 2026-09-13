import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { outreachJobs, type OutreachJobKind } from "@/db/schema";

/**
 * The generation-2 Outreach job queue (spec §5.5). Same claim shape as
 * `claimDueConnections`: one `UPDATE … WHERE id IN (SELECT … LIMIT n) AND <predicate>
 * RETURNING`. A second worker blocked on the same rows re-evaluates the predicate against the
 * updated version and skips them, so no job is claimed twice. Every write after a claim is
 * fenced on `lease_owner`.
 *
 * `attempts` counts FAILURES — a thrown or retried handler, or a lease abandoned by a crashed
 * worker — never a normal `continue`, so a long discovery run can yield hundreds of times.
 */

export type JobRow = {
  id: string;
  userId: string;
  campaignId: string | null;
  kind: OutreachJobKind;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  progress: Record<string, unknown>;
};

type RawJob = {
  id: string;
  user_id: string;
  campaign_id: string | null;
  kind: OutreachJobKind;
  payload: Record<string, unknown> | string | null;
  attempts: number;
  max_attempts: number;
  progress: Record<string, unknown> | string | null;
};

const asObject = (value: unknown): Record<string, unknown> =>
  typeof value === "string" ? (JSON.parse(value) as Record<string, unknown>) : ((value ?? {}) as Record<string, unknown>);

export async function enqueueJob(input: {
  userId: string;
  kind: OutreachJobKind;
  payload?: Record<string, unknown>;
  campaignId?: string | null;
  idempotencyKey?: string | null;
  runAfter?: Date;
  priority?: number;
  maxAttempts?: number;
}): Promise<{ id: string; created: boolean }> {
  const db = await getDb();
  const inserted = await db
    .insert(outreachJobs)
    .values({
      userId: input.userId,
      kind: input.kind,
      payload: input.payload ?? {},
      campaignId: input.campaignId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      runAfter: input.runAfter ?? new Date(),
      priority: input.priority ?? 0,
      maxAttempts: input.maxAttempts ?? 5,
    })
    .onConflictDoNothing({ target: [outreachJobs.userId, outreachJobs.idempotencyKey] })
    // Bare `.returning()`, not `.returning({ id })` — an explicit field selector defeats
    // Drizzle's overload resolution here (same trap noted below and in action-items.ts).
    .returning();
  if (inserted.length) return { id: inserted[0].id, created: true };
  const [existing] = await db
    .select({ id: outreachJobs.id })
    .from(outreachJobs)
    .where(and(eq(outreachJobs.userId, input.userId), eq(outreachJobs.idempotencyKey, input.idempotencyKey ?? "")));
  return { id: existing.id, created: false };
}

export async function claimJobs(workerId: string, limit: number, now: Date, leaseMs: number): Promise<JobRow[]> {
  const db = await getDb();
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const due = sql`(
    (status = 'queued' AND run_after <= ${now})
    OR (status = 'running' AND lease_expires_at < ${now} AND attempts + 1 < max_attempts)
  )`;
  const result = await db.execute(sql`
    UPDATE outreach_jobs
       SET attempts = attempts + CASE WHEN status = 'running' THEN 1 ELSE 0 END,
           status = 'running',
           lease_owner = ${workerId},
           lease_expires_at = ${leaseUntil},
           updated_at = ${now}
     WHERE id IN (
       SELECT id FROM outreach_jobs WHERE ${due} ORDER BY priority DESC, run_after LIMIT ${limit}
     )
       AND ${due}
    RETURNING id, user_id, campaign_id, kind, payload, attempts, max_attempts, progress
  `);
  return rowsOf<RawJob>(result).map((r) => ({
    id: r.id,
    userId: r.user_id,
    campaignId: r.campaign_id,
    kind: r.kind,
    payload: asObject(r.payload),
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
    progress: asObject(r.progress),
  }));
}

const held = (id: string, workerId: string) =>
  and(eq(outreachJobs.id, id), eq(outreachJobs.leaseOwner, workerId), eq(outreachJobs.status, "running"));

// Every write below reads only `rows.length`, so each uses a bare `.returning()`, not
// `.returning({ id: outreachJobs.id })` — an explicit field selector defeats Drizzle's
// overload resolution against the union `Db` type here (same trap noted in
// contact-identity.ts, action-items.ts and import-engine.ts).

export async function completeJob(id: string, workerId: string, result: Record<string, unknown>, now: Date) {
  const db = await getDb();
  const rows = await db
    .update(outreachJobs)
    .set({ status: "succeeded", result, finishedAt: now, leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
    .where(held(id, workerId))
    .returning();
  return rows.length > 0;
}

export async function continueJob(
  id: string,
  workerId: string,
  input: { runAfter: Date; progress?: Record<string, unknown> },
  now: Date
) {
  const db = await getDb();
  const rows = await db
    .update(outreachJobs)
    .set({
      status: "queued",
      runAfter: input.runAfter,
      ...(input.progress ? { progress: input.progress } : {}),
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(held(id, workerId))
    .returning();
  return rows.length > 0;
}

export async function retryJob(id: string, workerId: string, error: string, backoffMs: number, now: Date) {
  const db = await getDb();
  const result = await db.execute(sql`
    UPDATE outreach_jobs
       SET attempts = attempts + 1,
           last_error = ${error.slice(0, 500)},
           status = CASE WHEN attempts + 1 >= max_attempts THEN 'failed' ELSE 'queued' END,
           finished_at = CASE WHEN attempts + 1 >= max_attempts THEN ${now}::timestamptz ELSE NULL END,
           run_after = ${new Date(now.getTime() + backoffMs)},
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = ${now}
     WHERE id = ${id}::uuid AND lease_owner = ${workerId} AND status = 'running'
    RETURNING status
  `);
  const [row] = rowsOf<{ status: "queued" | "failed" }>(result);
  return row?.status ?? null;
}

export async function failJob(id: string, workerId: string, error: string, now: Date) {
  const db = await getDb();
  const rows = await db
    .update(outreachJobs)
    .set({ status: "failed", lastError: error.slice(0, 500), finishedAt: now, leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
    .where(held(id, workerId))
    .returning();
  return rows.length > 0;
}

export async function pauseJob(id: string, workerId: string, now: Date) {
  const db = await getDb();
  const rows = await db
    .update(outreachJobs)
    .set({ status: "paused", leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
    .where(held(id, workerId))
    .returning();
  return rows.length > 0;
}

export async function extendLease(id: string, workerId: string, leaseMs: number, now: Date) {
  const db = await getDb();
  const rows = await db
    .update(outreachJobs)
    .set({ leaseExpiresAt: new Date(now.getTime() + leaseMs), updatedAt: now })
    .where(held(id, workerId))
    .returning();
  return rows.length > 0;
}

export async function failExhaustedJobs(now: Date): Promise<number> {
  const db = await getDb();
  const result = await db.execute(sql`
    UPDATE outreach_jobs
       SET status = 'failed', last_error = 'Stopped after repeated interruptions', finished_at = ${now},
           lease_owner = NULL, lease_expires_at = NULL, updated_at = ${now}
     WHERE status = 'running' AND lease_expires_at < ${now} AND attempts + 1 >= max_attempts
    RETURNING id
  `);
  return rowsOf(result).length;
}

export async function resumePausedJobs(userId: string, now: Date): Promise<number> {
  const db = await getDb();
  const rows = await db
    .update(outreachJobs)
    .set({ status: "queued", runAfter: now, updatedAt: now })
    .where(and(eq(outreachJobs.userId, userId), eq(outreachJobs.status, "paused")))
    .returning();
  return rows.length;
}

export async function cancelJobs(
  userId: string,
  filter: { campaignId?: string; kinds?: OutreachJobKind[]; runId?: string },
  now: Date
): Promise<number> {
  const db = await getDb();
  const conditions = [
    eq(outreachJobs.userId, userId),
    inArray(outreachJobs.status, ["queued", "paused"]),
    ...(filter.campaignId ? [eq(outreachJobs.campaignId, filter.campaignId)] : []),
    ...(filter.kinds?.length ? [inArray(outreachJobs.kind, filter.kinds)] : []),
    ...(filter.runId ? [sql`${outreachJobs.payload}->>'runId' = ${filter.runId}`] : []),
  ];
  const rows = await db
    .update(outreachJobs)
    .set({ status: "cancelled", finishedAt: now, leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
    .where(and(...conditions))
    .returning();
  return rows.length;
}

export async function countOutstandingJobs(
  userId: string,
  filter: { campaignId: string; kind: OutreachJobKind; runId?: string }
): Promise<number> {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT count(*)::int AS n FROM outreach_jobs
     WHERE user_id = ${userId} AND campaign_id = ${filter.campaignId}::uuid AND kind = ${filter.kind}
       AND status IN ('queued', 'running', 'paused')
       ${filter.runId ? sql`AND payload->>'runId' = ${filter.runId}` : sql``}
  `);
  return Number(rowsOf<{ n: number }>(result)[0]?.n ?? 0);
}

/** 0 if something is claimable now, the wait until the next queued job, or null if idle. */
export async function msUntilNextDue(now: Date): Promise<number | null> {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT
      EXISTS (SELECT 1 FROM outreach_jobs WHERE status = 'running' AND lease_expires_at < ${now} AND attempts + 1 < max_attempts) AS stale,
      (SELECT min(run_after) FROM outreach_jobs WHERE status = 'queued') AS next_at
  `);
  const [row] = rowsOf<{ stale: boolean; next_at: string | Date | null }>(result);
  if (row?.stale) return 0;
  if (!row?.next_at) return null;
  return Math.max(0, new Date(row.next_at).getTime() - now.getTime());
}
