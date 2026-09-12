import {
  and,
  desc,
  eq,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { getDb } from "@/db";
import { adminIssues } from "@/db/schema";

export type DetectedAdminIssue = {
  fingerprint: string;
  source: string;
  severity: "warn" | "error";
  title: string;
  message: string;
  targetUserId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
};

export type AdminIssue = Omit<typeof adminIssues.$inferSelect, "state"> & {
  state: "open" | "acknowledged" | "snoozed" | "resolved";
};

function derivedState(
  row: typeof adminIssues.$inferSelect,
  now = new Date()
): AdminIssue["state"] {
  if (row.state === "resolved") return "resolved";
  if (row.snoozedUntil && row.snoozedUntil > now) return "snoozed";
  return row.state;
}

/**
 * Upsert every currently detected condition and resolve prior conditions from the same
 * detector that disappeared. A resolved fingerprint reopening clears prior operator state
 * and increments its occurrence count atomically.
 */
export async function reconcileAdminIssues(
  source: string,
  detected: DetectedAdminIssue[],
  now = new Date()
): Promise<void> {
  const db = await getDb();
  const current = detected.filter((issue) => issue.source === source);

  for (const issue of current) {
    await db
      .insert(adminIssues)
      .values({
        fingerprint: issue.fingerprint,
        source: issue.source,
        severity: issue.severity,
        title: issue.title,
        message: issue.message,
        targetUserId: issue.targetUserId ?? null,
        resourceType: issue.resourceType ?? null,
        resourceId: issue.resourceId ?? null,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: adminIssues.fingerprint,
        set: {
          severity: issue.severity,
          title: issue.title,
          message: issue.message,
          targetUserId: issue.targetUserId ?? null,
          resourceType: issue.resourceType ?? null,
          resourceId: issue.resourceId ?? null,
          lastSeenAt: now,
          state: sql`CASE WHEN ${adminIssues.state} = 'resolved' THEN 'open' ELSE ${adminIssues.state} END`,
          occurrenceCount: sql`${adminIssues.occurrenceCount} + CASE WHEN ${adminIssues.state} = 'resolved' THEN 1 ELSE 0 END`,
          acknowledgedAt: sql`CASE WHEN ${adminIssues.state} = 'resolved' THEN NULL ELSE ${adminIssues.acknowledgedAt} END`,
          acknowledgedBy: sql`CASE WHEN ${adminIssues.state} = 'resolved' THEN NULL ELSE ${adminIssues.acknowledgedBy} END`,
          snoozedUntil: sql`CASE WHEN ${adminIssues.state} = 'resolved' THEN NULL ELSE ${adminIssues.snoozedUntil} END`,
          resolvedAt: null,
        },
      });
  }

  const active = await db.query.adminIssues.findMany({
    where: and(eq(adminIssues.source, source), ne(adminIssues.state, "resolved")),
    columns: { id: true, fingerprint: true },
  });
  const fingerprints = new Set(current.map((issue) => issue.fingerprint));
  for (const issue of active) {
    if (fingerprints.has(issue.fingerprint)) continue;
    await db
      .update(adminIssues)
      .set({ state: "resolved", resolvedAt: now, snoozedUntil: null })
      .where(eq(adminIssues.id, issue.id));
  }
}

export async function listAdminIssues(options: {
  includeResolved?: boolean;
  includeSnoozed?: boolean;
  limit?: number;
} = {}): Promise<AdminIssue[]> {
  const db = await getDb();
  const now = new Date();
  const filters = [];
  if (!options.includeResolved) filters.push(ne(adminIssues.state, "resolved"));
  if (!options.includeSnoozed) {
    filters.push(
      or(isNull(adminIssues.snoozedUntil), lte(adminIssues.snoozedUntil, now))!
    );
  }
  const rows = await db.query.adminIssues.findMany({
    where: filters.length ? and(...filters) : undefined,
    orderBy: [
      sql`CASE ${adminIssues.severity} WHEN 'error' THEN 0 ELSE 1 END`,
      desc(adminIssues.lastSeenAt),
    ],
    limit: Math.min(Math.max(options.limit ?? 50, 1), 200),
  });
  return rows.map((row) => ({ ...row, state: derivedState(row, now) }));
}

export async function acknowledgeIssue(
  issueId: string,
  adminUserId: string
): Promise<AdminIssue> {
  const db = await getDb();
  const now = new Date();
  const [row] = await db
    .update(adminIssues)
    .set({
      state: "acknowledged",
      acknowledgedAt: now,
      acknowledgedBy: adminUserId,
      snoozedUntil: null,
    })
    .where(and(eq(adminIssues.id, issueId), ne(adminIssues.state, "resolved")))
    .returning();
  if (!row) throw new Error("This issue is no longer active.");
  return { ...row, state: derivedState(row, now) };
}

export async function snoozeIssue(
  issueId: string,
  adminUserId: string,
  until: Date
): Promise<AdminIssue> {
  const db = await getDb();
  const now = new Date();
  if (until <= now || until.getTime() - now.getTime() > 7 * 24 * 60 * 60 * 1000) {
    throw new Error("Choose a snooze between one minute and seven days.");
  }
  const [row] = await db
    .update(adminIssues)
    .set({
      state: "acknowledged",
      acknowledgedAt: now,
      acknowledgedBy: adminUserId,
      snoozedUntil: until,
    })
    .where(and(eq(adminIssues.id, issueId), ne(adminIssues.state, "resolved")))
    .returning();
  if (!row) throw new Error("This issue is no longer active.");
  return { ...row, state: derivedState(row, now) };
}

export async function unsnoozeIssue(issueId: string): Promise<AdminIssue> {
  const db = await getDb();
  const [row] = await db
    .update(adminIssues)
    .set({ snoozedUntil: null })
    .where(and(eq(adminIssues.id, issueId), ne(adminIssues.state, "resolved")))
    .returning();
  if (!row) throw new Error("This issue is no longer active.");
  return { ...row, state: derivedState(row) };
}

export async function pruneResolvedAdminIssues(
  olderThan = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
): Promise<number> {
  const db = await getDb();
  const removed = await db
    .delete(adminIssues)
    .where(
      and(
        eq(adminIssues.state, "resolved"),
        lt(adminIssues.resolvedAt, olderThan)
      )
    )
    .returning();
  return removed.length;
}
