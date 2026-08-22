import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  adminAuditLog,
  calendarSubscriptions,
  gmailConnections,
  imports,
  outlookConnections,
  userSettings,
} from "@/db/schema";
import { isAdminUser } from "@/lib/admin";
import {
  createRevealGrant,
  describeActiveGrant,
  revokeRevealGrants,
} from "@/lib/admin-reveal";
import { runLinkedInImportJob } from "@/lib/import-job-processor";
import { purgeUserData } from "@/lib/user-data";

/**
 * The operator write operations, as plain functions taking an explicit `adminUserId`.
 *
 * They live here rather than in `src/actions/admin.ts` for the reason every other domain in
 * this repo splits the same way: an action resolves identity and delegates, a lib does the
 * work and never reads auth itself. Two things fall out of that here specifically.
 *
 * First, these are reachable from scripts. `requireAdminUserId()` needs a Clerk request
 * context, so an action body cannot be exercised outside a request — which would have left
 * the guards below, the most safety-critical code in the console, untested.
 * `scripts/smoke-admin-actions.ts` covers them because they are here.
 *
 * Second, taking the admin id as an argument makes it obvious at every call site that
 * somebody upstream had to establish it. The gate is still in the action, and still
 * mandatory: every export in `src/actions/admin.ts` calls `requireAdminUserId()` first,
 * because layouts do not re-run for Server Action POSTs.
 *
 * WHAT IS DELIBERATELY NOT HERE: `revalidatePath` and `after`. Both only mean anything
 * inside a request — `after` throws outright without one — so putting either here would
 * make these functions silently request-bound again, which is the thing the split avoids.
 * `retryImport` therefore prepares the job and hands the caller back the id to schedule.
 */

/** Every privileged mutation writes one of these, awaited, before or with the mutation. */
export async function recordAdminAction(input: {
  adminUserId: string;
  action: string;
  targetUserId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  detail?: Record<string, unknown>;
  reason?: string | null;
}) {
  const db = await getDb();
  await db.insert(adminAuditLog).values({
    adminUserId: input.adminUserId,
    action: input.action,
    targetUserId: input.targetUserId ?? null,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    detail: input.detail ?? {},
    reason: input.reason?.trim() || null,
  });
}

export function requireReason(reason: string, minimum = 4): string {
  const trimmed = reason.trim();
  if (trimmed.length < minimum) {
    throw new Error(
      `Describe why this is being done (at least ${minimum} characters).`
    );
  }
  return trimmed;
}

/**
 * The guard on every destructive operation.
 *
 * Suspending or deleting your own account would lock you out of the console that contains
 * the unlock button — `requireAdminUserId()` calls `requireUserId()`, which is where the
 * suspension check lives. Refusing any operator id, not just the caller's, covers the case
 * where ADMIN_USER_IDS lists more than one person.
 */
export function assertNotOperator(adminUserId: string, targetUserId: string) {
  if (targetUserId === adminUserId) {
    throw new Error("Refusing to act on your own account.");
  }
  if (isAdminUser(targetUserId)) {
    throw new Error("Refusing to act on an operator account.");
  }
}

async function requireAccount(targetUserId: string) {
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, targetUserId),
    columns: { userId: true, email: true, suspendedAt: true },
  });
  if (!row) throw new Error("No such account.");
  return row;
}

/* ------------------------------------------------------------------------- reveal grants */

export type RevealGrantResult = {
  ok: true;
  grantId: string;
  expiresAt: string;
};

/**
 * Unmask one account's contact and interaction content for a short window.
 *
 * The grant is what widens the query layer's column allowlist; see `src/lib/admin-reveal.ts`
 * for why it is a branded capability rather than a flag. `record.reveal` remains for the
 * one-record case — this is the "the import mangled rows 300-400" tool, not a replacement.
 */
export async function grantReveal(adminUserId: string, input: {
  targetUserId: string;
  reason: string;
}): Promise<{ grantId: string; expiresAt: Date }> {
  const reason = requireReason(input.reason, 8);
  await requireAccount(input.targetUserId);

  const grant = await createRevealGrant({
    adminUserId,
    targetUserId: input.targetUserId,
    reason,
  });

  await recordAdminAction({
    adminUserId,
    action: "reveal.grant",
    targetUserId: input.targetUserId,
    resourceType: "reveal_grant",
    resourceId: grant.id,
    detail: { expiresAt: grant.expiresAt.toISOString() },
    reason,
  });

  return { grantId: grant.id, expiresAt: grant.expiresAt };
}

/** Re-mask now, without waiting for the grant to age out. */
export async function revokeReveal(adminUserId: string, input: {
  targetUserId: string;
}): Promise<number> {
  const revoked = await revokeRevealGrants(adminUserId, input.targetUserId);

  // Only log when something was actually open; a no-op revoke is noise in the trail.
  if (revoked > 0) {
    await recordAdminAction({
      adminUserId,
      action: "reveal.revoke",
      targetUserId: input.targetUserId,
      detail: { revoked },
    });
  }

  return revoked;
}

/** Banner state for the inspector. Never returns a grant object. */
export async function getActiveRevealGrantFor(adminUserId: string, targetUserId: string) {
  return describeActiveGrant(adminUserId, targetUserId);
}

/* ------------------------------------------------------------------------------ imports */

/**
 * Re-arm a failed or stuck import, and return the id of the job to run.
 *
 * Only LinkedIn connection imports are resumable: they are the one type that stages
 * `import_job_rows`, which is what lets `runLinkedInImportJob` pick up where it stopped.
 * It re-reads job and row status from the database rather than assuming a fresh start,
 * which is exactly what makes a manual retry safe.
 *
 * The job is deliberately not started here. It is time-boxed with self-continuation and can
 * run far longer than a server action should, so the caller schedules it with `after()` —
 * which needs a request scope this function does not assume it has. `runImportJob` below is
 * the shared body both the action and a script can use.
 */
export async function retryImport(adminUserId: string, input: {
  targetUserId: string;
  importId: string;
  reason: string;
}): Promise<{ importId: string }> {
  const reason = requireReason(input.reason);

  const db = await getDb();
  const job = await db.query.imports.findFirst({
    where: and(
      eq(imports.id, input.importId),
      eq(imports.userId, input.targetUserId)
    ),
  });
  if (!job) throw new Error("No such import.");
  if (job.importType !== "linkedin_connections") {
    throw new Error(
      "Only LinkedIn connection imports stage resumable rows; this type has to be re-uploaded by the user."
    );
  }
  if (job.status === "completed") throw new Error("That import already completed.");

  await recordAdminAction({
    adminUserId,
    action: "import.retry",
    targetUserId: input.targetUserId,
    resourceType: "import",
    resourceId: input.importId,
    detail: { fromStatus: job.status, importType: job.importType },
    reason,
  });

  await db
    .update(imports)
    .set({ status: "processing", errorMessage: null, updatedAt: new Date() })
    .where(eq(imports.id, input.importId));

  return { importId: input.importId };
}

/** Runs a re-armed job, swallowing failures the processor already records on the job row. */
export async function runImportJob(importId: string): Promise<void> {
  try {
    await runLinkedInImportJob(importId);
  } catch {
    // The processor writes its own error onto the import row; nothing to add here.
  }
}

/** Clear an import wedged in `processing` so the user can start a clean one. */
export async function cancelImport(adminUserId: string, input: {
  targetUserId: string;
  importId: string;
  reason: string;
}): Promise<void> {
  const reason = requireReason(input.reason);

  const db = await getDb();
  const job = await db.query.imports.findFirst({
    where: and(
      eq(imports.id, input.importId),
      eq(imports.userId, input.targetUserId)
    ),
    columns: { id: true, status: true, importType: true },
  });
  if (!job) throw new Error("No such import.");

  await recordAdminAction({
    adminUserId,
    action: "import.cancel",
    targetUserId: input.targetUserId,
    resourceType: "import",
    resourceId: input.importId,
    detail: { fromStatus: job.status },
    reason,
  });

  await db
    .update(imports)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(imports.id, input.importId));

}

/* -------------------------------------------------------------------------- onboarding */

/**
 * Walk an account back through setup.
 *
 * WORTH KNOWING BEFORE USING THIS: `needsOnboarding()` treats "has any contact or import"
 * as onboarded regardless of the timestamp, and backfills the column afterwards. On a
 * populated account this action therefore does nothing the user will ever see. It is for
 * accounts that stalled early — which is the only case where re-running setup helps anyway.
 */
export async function resetOnboarding(adminUserId: string, input: {
  targetUserId: string;
  scope: "onboarding" | "wizard" | "both";
  reason: string;
}): Promise<void> {
  const reason = requireReason(input.reason);
  await requireAccount(input.targetUserId);

  const values: Partial<typeof userSettings.$inferInsert> = { updatedAt: new Date() };
  if (input.scope === "onboarding" || input.scope === "both") {
    values.onboardingCompletedAt = null;
    values.onboardingStep = null;
  }
  if (input.scope === "wizard" || input.scope === "both") {
    values.wizardCompletedAt = null;
    values.wizardOfferedAt = null;
    values.wizardStep = null;
  }

  await recordAdminAction({
    adminUserId,
    action: "onboarding.reset",
    targetUserId: input.targetUserId,
    detail: { scope: input.scope },
    reason,
  });

  const db = await getDb();
  await db
    .update(userSettings)
    .set(values)
    .where(eq(userSettings.userId, input.targetUserId));

}

/* ------------------------------------------------------------------------ integrations */

/**
 * Force-clear a dead Gmail or Outlook connection so the user can reconnect cleanly.
 *
 * Deleting the row *is* the disconnect, exactly as `disconnectGmail()` does it for the user
 * themselves. No token is ever decrypted — not to revoke it upstream, not to log it.
 */
export async function disconnectIntegration(adminUserId: string, input: {
  targetUserId: string;
  provider: "gmail" | "outlook";
  reason: string;
}): Promise<void> {
  const reason = requireReason(input.reason);
  await requireAccount(input.targetUserId);

  await recordAdminAction({
    adminUserId,
    action: "integration.disconnect",
    targetUserId: input.targetUserId,
    resourceType: input.provider,
    detail: { provider: input.provider },
    reason,
  });

  const db = await getDb();
  const table =
    input.provider === "gmail" ? gmailConnections : outlookConnections;
  await db.delete(table).where(eq(table.userId, input.targetUserId));

}

/** Silence a calendar feed that is erroring on every sync, without deleting the user's URL. */
export async function setCalendarFeedEnabled(adminUserId: string, input: {
  targetUserId: string;
  subscriptionId: string;
  enabled: boolean;
  reason: string;
}): Promise<void> {
  const reason = requireReason(input.reason);

  const db = await getDb();
  const sub = await db.query.calendarSubscriptions.findFirst({
    where: and(
      eq(calendarSubscriptions.id, input.subscriptionId),
      eq(calendarSubscriptions.userId, input.targetUserId)
    ),
    columns: { id: true, label: true },
  });
  if (!sub) throw new Error("No such calendar subscription.");

  await recordAdminAction({
    adminUserId,
    action: input.enabled ? "calendar.enable" : "calendar.disable",
    targetUserId: input.targetUserId,
    resourceType: "calendar_subscription",
    resourceId: input.subscriptionId,
    reason,
  });

  await db
    .update(calendarSubscriptions)
    .set({ enabled: input.enabled ? 1 : 0, updatedAt: new Date() })
    .where(eq(calendarSubscriptions.id, input.subscriptionId));

}

/* ------------------------------------------------------------------ account lifecycle */

/**
 * Suspend or restore an account.
 *
 * Enforced in `requireUserId()` (`src/lib/auth.ts`), not in a layout: layouts do not run
 * for Server Action POSTs, and `requireUserId` is the one function every page, action and
 * route handler already funnels through. It already loads the settings row, so the check
 * costs nothing.
 */
export async function setAccountSuspended(adminUserId: string, input: {
  targetUserId: string;
  suspended: boolean;
  reason: string;
}): Promise<{ suspendedAt: Date | null }> {
  const reason = requireReason(input.reason);
  assertNotOperator(adminUserId, input.targetUserId);
  await requireAccount(input.targetUserId);

  const suspendedAt = input.suspended ? new Date() : null;

  await recordAdminAction({
    adminUserId,
    action: input.suspended ? "account.suspend" : "account.unsuspend",
    targetUserId: input.targetUserId,
    reason,
  });

  const db = await getDb();
  await db
    .update(userSettings)
    .set({
      suspendedAt,
      suspendedReason: input.suspended ? reason : null,
      suspendedBy: input.suspended ? adminUserId : null,
      updatedAt: new Date(),
    })
    .where(eq(userSettings.userId, input.targetUserId));

  return { suspendedAt };
}

/**
 * Delete every trace of an account's Orbit data.
 *
 * `confirmEmail` must match the account's own email verbatim. That is not ceremony: the
 * roster is a list of near-identical rows, and the failure mode this guards against is
 * deleting the account next to the one you meant.
 *
 * The audit row is written first, because `purgeUserData` deletes `user_settings` — and
 * that module deliberately preserves `admin_audit_log` rows, so this remains the only
 * lasting record that the account existed and who removed it.
 *
 * Does NOT delete the Clerk account. The user can still sign in; they will land in
 * onboarding with an empty workspace.
 */
export async function deleteAccount(adminUserId: string, input: {
  targetUserId: string;
  confirmEmail: string;
  reason: string;
}): Promise<void> {
  const reason = requireReason(input.reason, 8);
  assertNotOperator(adminUserId, input.targetUserId);

  const account = await requireAccount(input.targetUserId);
  const expected = (account.email ?? "").trim().toLowerCase();
  const provided = input.confirmEmail.trim().toLowerCase();
  if (!expected) {
    throw new Error(
      "This account has no email on file, so the confirmation cannot be checked. Delete it with scripts/ instead."
    );
  }
  if (expected !== provided) {
    throw new Error("That email does not match this account.");
  }

  await recordAdminAction({
    adminUserId,
    action: "account.delete",
    targetUserId: input.targetUserId,
    detail: { email: account.email },
    reason,
  });

  await purgeUserData(input.targetUserId);

}

/* ---------------------------------------------------------------------- the audit trail */

export type AuditQuery = {
  action?: string;
  targetUserId?: string;
  page?: number;
  pageSize?: number;
};

export type AuditPage = {
  rows: Array<{
    id: string;
    adminUserId: string;
    action: string;
    targetUserId: string | null;
    targetEmail: string | null;
    resourceType: string | null;
    resourceId: string | null;
    detail: Record<string, unknown>;
    reason: string | null;
    createdAt: Date;
  }>;
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  /** Distinct action names present, for the filter bar. */
  actions: string[];
};

/**
 * The whole audit log, paginated and filterable.
 *
 * `getAuditTrail` in the actions module returns 25 rows for one account, which was right
 * when the console could perform two kinds of write. With fourteen, a per-account window
 * stops being a record you can answer questions from.
 *
 * The target email is LEFT JOINed rather than stored on the row: an account can be deleted,
 * and `purgeUserData` deliberately spares these rows, so the join simply yields null and the
 * entry survives as "some account that no longer exists" — which is the honest rendering.
 */
/** `and()` needs at least one operand; this is the always-true seed. */
function sqlTrue() {
  return sql`true`;
}

export async function loadAuditLog(query: AuditQuery = {}): Promise<AuditPage> {
  const db = await getDb();
  const pageSize = Math.min(Math.max(query.pageSize ?? 50, 1), 200);
  const page = Math.max(query.page ?? 1, 1);

  const filters = [sqlTrue()];
  if (query.action) filters.push(eq(adminAuditLog.action, query.action));
  if (query.targetUserId) {
    filters.push(eq(adminAuditLog.targetUserId, query.targetUserId));
  }
  const where = and(...filters);

  const [rows, totalAgg, actionRows] = await Promise.all([
    db
      .select({
        id: adminAuditLog.id,
        adminUserId: adminAuditLog.adminUserId,
        action: adminAuditLog.action,
        targetUserId: adminAuditLog.targetUserId,
        targetEmail: userSettings.email,
        resourceType: adminAuditLog.resourceType,
        resourceId: adminAuditLog.resourceId,
        detail: adminAuditLog.detail,
        reason: adminAuditLog.reason,
        createdAt: adminAuditLog.createdAt,
      })
      .from(adminAuditLog)
      .leftJoin(userSettings, eq(userSettings.userId, adminAuditLog.targetUserId))
      .where(where)
      .orderBy(desc(adminAuditLog.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),

    db
      .select({ n: sql<number>`count(*)::int` })
      .from(adminAuditLog)
      .where(where),

    db
      .selectDistinct({ action: adminAuditLog.action })
      .from(adminAuditLog)
      .orderBy(adminAuditLog.action),
  ]);

  const total = totalAgg[0]?.n ?? 0;

  return {
    rows: rows.map((r) => ({
      ...r,
      detail: (r.detail ?? {}) as Record<string, unknown>,
    })),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    actions: actionRows.map((r) => r.action),
  };
}
