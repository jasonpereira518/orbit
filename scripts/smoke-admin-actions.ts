/**
 * Exercises the operator write actions and, more importantly, their refusals.
 *
 * The actions themselves are small; what has to hold is the fence around them. Suspending
 * or deleting an operator account would lock the console's own unlock button behind the
 * suspension it just created, and deleting the wrong row is unrecoverable — so the guards
 * get more assertions here than the happy paths do.
 *
 * These call the action modules directly rather than over HTTP, so `requireAdminUserId()`
 * is exercised through the same env-allowlist gate the real requests use.
 *
 * Run: npx tsx scripts/smoke-admin-actions.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { and, eq, inArray, like } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  adminAuditLog,
  calendarSubscriptions,
  chatMessages,
  chatThreads,
  contacts,
  gmailConnections,
  imports,
  interactions,
  outlookConnections,
  usageEvents,
  userSettings,
} from "../src/db/schema";
import { ensureUserSettings } from "../src/lib/user-settings";

const PREFIX = "smoke-actions-";
const ADMIN = `${PREFIX}operator`;
const TARGET = `${PREFIX}target`;
const OTHER_OP = `${PREFIX}second-operator`;
const IDS = [ADMIN, TARGET, OTHER_OP];

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/** Asserts a call rejects, and that it rejects for the expected reason. */
async function refuses(label: string, fn: () => Promise<unknown>, match?: RegExp) {
  let message: string | null = null;
  try {
    await fn();
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  if (message === null) throw new Error(`${label} failed: the call was allowed`);
  if (match && !match.test(message)) {
    throw new Error(`${label} failed: rejected with "${message}"`);
  }
  console.log(`  ok  ${label}`);
}

async function auditRows(action: string) {
  const db = await getDb();
  return db.query.adminAuditLog.findMany({
    where: and(
      eq(adminAuditLog.action, action),
      eq(adminAuditLog.targetUserId, TARGET)
    ),
  });
}

async function cleanup() {
  const db = await getDb();
  await db.delete(usageEvents).where(inArray(usageEvents.userId, IDS));
  await db.delete(interactions).where(inArray(interactions.userId, IDS));
  await db.delete(contacts).where(inArray(contacts.userId, IDS));
  await db.delete(chatMessages).where(inArray(chatMessages.userId, IDS));
  await db.delete(chatThreads).where(inArray(chatThreads.userId, IDS));
  await db.delete(imports).where(inArray(imports.userId, IDS));
  await db.delete(calendarSubscriptions).where(inArray(calendarSubscriptions.userId, IDS));
  await db.delete(gmailConnections).where(inArray(gmailConnections.userId, IDS));
  await db.delete(outlookConnections).where(inArray(outlookConnections.userId, IDS));
  await db.delete(adminAuditLog).where(like(adminAuditLog.targetUserId, `${PREFIX}%`));
  await db.delete(userSettings).where(inArray(userSettings.userId, IDS));
}

async function main() {
  console.log("Admin actions");

  // `isAdminUser` reads env at call time, which is what the operator guards consult.
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_fake";
  process.env.ADMIN_USER_IDS = `${ADMIN} ${OTHER_OP}`;

  await cleanup();
  const db = await getDb();
  for (const id of IDS) await ensureUserSettings(id);
  await db
    .update(userSettings)
    .set({ email: "target@example.test" })
    .where(eq(userSettings.userId, TARGET));

  // Exercised through the lib rather than through `src/actions/admin.ts`: an action body
  // calls `requireAdminUserId()`, which needs a Clerk request context that no script has.
  // The actions are thin wrappers over exactly these functions — see the module header.
  const actions = await import("../src/lib/admin-operations");

  /* ------------------------------------------------------------------- reason required */

  await refuses(
    "an empty reason is refused",
    () =>
      actions.setAccountSuspended(ADMIN, {
        targetUserId: TARGET,
        suspended: true,
        reason: "   ",
      }),
    /at least/i
  );

  /* --------------------------------------------------------------- the operator guards */

  await refuses(
    "suspending your own account is refused",
    () =>
      actions.setAccountSuspended(ADMIN, {
        targetUserId: ADMIN,
        suspended: true,
        reason: "testing the self-target guard",
      }),
    /your own account/i
  );

  await refuses(
    "suspending another operator is refused",
    () =>
      actions.setAccountSuspended(ADMIN, {
        targetUserId: OTHER_OP,
        suspended: true,
        reason: "testing the operator guard",
      }),
    /operator account/i
  );

  await refuses(
    "deleting your own account is refused",
    () =>
      actions.deleteAccount(ADMIN, {
        targetUserId: ADMIN,
        confirmEmail: "whatever@example.test",
        reason: "testing the self-target guard",
      }),
    /your own account/i
  );

  await refuses(
    "deleting another operator is refused",
    () =>
      actions.deleteAccount(ADMIN, {
        targetUserId: OTHER_OP,
        confirmEmail: "whatever@example.test",
        reason: "testing the operator guard",
      }),
    /operator account/i
  );

  /* ---------------------------------------------------------------------- suspension */

  const suspended = await actions.setAccountSuspended(ADMIN, {
    targetUserId: TARGET,
    suspended: true,
    reason: "abusive content reported by three users",
  });
  check("suspend returns a timestamp", suspended.suspendedAt instanceof Date);

  const afterSuspend = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, TARGET),
  });
  check("suspended_at is written", afterSuspend?.suspendedAt != null);
  check(
    "the reason and operator are recorded on the row",
    afterSuspend?.suspendedBy === ADMIN &&
      (afterSuspend?.suspendedReason ?? "").includes("abusive content")
  );
  check("suspend writes exactly one audit row", (await auditRows("account.suspend")).length === 1);

  // The ICS feed authenticates by token and never calls requireUserId, so it needs its own
  // check — this is the bypass a suspension gate is most likely to miss.
  const { findUserByFeedToken } = await import("../src/lib/calendar-feed");
  const feedToken = "smoke-actions-feed-token-0123456789abcdef";
  await db
    .update(userSettings)
    .set({ calendarFeedToken: feedToken })
    .where(eq(userSettings.userId, TARGET));
  check(
    "the ICS feed goes quiet for a suspended account",
    (await findUserByFeedToken(feedToken)) === null
  );

  const unsuspended = await actions.setAccountSuspended(ADMIN, {
    targetUserId: TARGET,
    suspended: false,
    reason: "report was unfounded on review",
  });
  check("unsuspend clears the timestamp", unsuspended.suspendedAt === null);
  const afterRestore = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, TARGET),
  });
  check(
    "unsuspend clears the reason and operator too",
    afterRestore?.suspendedReason === null && afterRestore?.suspendedBy === null
  );
  check(
    "the ICS feed comes back after unsuspending",
    (await findUserByFeedToken(feedToken)) !== null
  );
  check("unsuspend writes its own audit row", (await auditRows("account.unsuspend")).length === 1);

  /* -------------------------------------------------------------------------- imports */

  const [linkedinJob] = await db
    .insert(imports)
    .values({
      userId: TARGET,
      importType: "linkedin_connections",
      fileName: "connections.csv",
      status: "failed",
      errorMessage: "boom",
      totalRows: 100,
    })
    .returning();

  const [csvJob] = await db
    .insert(imports)
    .values({
      userId: TARGET,
      importType: "google_contacts",
      fileName: "contacts.csv",
      status: "failed",
    })
    .returning();

  await refuses(
    "retrying a non-resumable import type is refused",
    () =>
      actions.retryImport(ADMIN, {
        targetUserId: TARGET,
        importId: csvJob.id,
        reason: "user asked",
      }),
    /re-uploaded/i
  );

  await refuses(
    "retrying another account's import is refused",
    () =>
      actions.retryImport(ADMIN, {
        targetUserId: OTHER_OP,
        importId: linkedinJob.id,
        reason: "wrong account",
      }),
    /No such import/i
  );

  await actions.retryImport(ADMIN, {
    targetUserId: TARGET,
    importId: linkedinJob.id,
    reason: "rows staged fine, processor died mid-run",
  });
  const retried = await db.query.imports.findFirst({
    where: eq(imports.id, linkedinJob.id),
  });
  check("retry clears the error message", retried?.errorMessage === null);
  check("retry writes an audit row", (await auditRows("import.retry")).length === 1);

  await actions.cancelImport(ADMIN, {
    targetUserId: TARGET,
    importId: csvJob.id,
    reason: "wedged, user starting over",
  });
  const cancelled = await db.query.imports.findFirst({
    where: eq(imports.id, csvJob.id),
  });
  check("cancel sets the status", cancelled?.status === "cancelled");
  check("cancel writes an audit row", (await auditRows("import.cancel")).length === 1);

  /* ----------------------------------------------------------------------- onboarding */

  await db
    .update(userSettings)
    .set({
      onboardingCompletedAt: new Date(),
      onboardingStep: "done",
      wizardCompletedAt: new Date(),
    })
    .where(eq(userSettings.userId, TARGET));

  await actions.resetOnboarding(ADMIN, {
    targetUserId: TARGET,
    scope: "both",
    reason: "account stalled at step one",
  });
  const reset = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, TARGET),
  });
  check(
    "reset clears both onboarding and wizard state",
    reset?.onboardingCompletedAt === null &&
      reset?.onboardingStep === null &&
      reset?.wizardCompletedAt === null
  );
  check("reset writes an audit row", (await auditRows("onboarding.reset")).length === 1);

  /* --------------------------------------------------------------------- integrations */

  await db.insert(gmailConnections).values({
    userId: TARGET,
    emailAddress: "target@gmail.test",
    accessTokenEncrypted: "ciphertext-access",
    refreshTokenEncrypted: "ciphertext-refresh",
    status: "needs_reauth",
  });

  await actions.disconnectIntegration(ADMIN, {
    targetUserId: TARGET,
    provider: "gmail",
    reason: "token revoked upstream, user needs a clean reconnect",
  });
  const gone = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, TARGET),
  });
  check("disconnect deletes the connection row", gone === undefined);
  check(
    "disconnect writes an audit row",
    (await auditRows("integration.disconnect")).length === 1
  );

  const [sub] = await db
    .insert(calendarSubscriptions)
    .values({
      userId: TARGET,
      label: "Work",
      icsUrl: "https://example.test/cal.ics",
      lastSyncStatus: "error",
      lastSyncError: "404",
    })
    .returning();

  await actions.setCalendarFeedEnabled(ADMIN, {
    targetUserId: TARGET,
    subscriptionId: sub.id,
    enabled: false,
    reason: "erroring on every sync",
  });
  const disabled = await db.query.calendarSubscriptions.findFirst({
    where: eq(calendarSubscriptions.id, sub.id),
  });
  check("calendar feed is disabled", disabled?.enabled === 0);
  check(
    "the ICS url is preserved, not deleted",
    disabled?.icsUrl === "https://example.test/cal.ics"
  );
  check("disable writes an audit row", (await auditRows("calendar.disable")).length === 1);

  /* --------------------------------------------------------------------- account view */

  // What is left of the reveal gate. The operator no longer justifies a look, but the look
  // is still recorded — and the throttle is the part worth testing, because the inspector
  // re-renders on every mutation and an unthrottled insert would bury the audit log in
  // duplicate view rows.
  await actions.recordAccountView(ADMIN, TARGET);
  check("opening an account writes an audit row", (await auditRows("account.view")).length === 1);

  await actions.recordAccountView(ADMIN, TARGET);
  check(
    "a second view inside the hour writes no second row",
    (await auditRows("account.view")).length === 1
  );

  // Two hours on, it is a new session rather than the same page being refreshed.
  await actions.recordAccountView(
    ADMIN,
    TARGET,
    new Date(Date.now() + 2 * 60 * 60 * 1000)
  );
  check(
    "a view outside the window writes a fresh row",
    (await auditRows("account.view")).length === 2
  );

  /* -------------------------------------------------------------------------- deletion */

  await db.insert(contacts).values({ userId: TARGET, fullName: "Doomed Contact" });

  await refuses(
    "deleting with a mismatched confirmation email is refused",
    () =>
      actions.deleteAccount(ADMIN, {
        targetUserId: TARGET,
        confirmEmail: "not-the-right@example.test",
        reason: "should never get here",
      }),
    /does not match/i
  );
  const survived = await db.query.contacts.findMany({
    where: eq(contacts.userId, TARGET),
  });
  check("a refused delete touched nothing", survived.length === 1);

  await actions.deleteAccount(ADMIN, {
    targetUserId: TARGET,
    confirmEmail: "TARGET@Example.Test", // case-insensitive on purpose
    reason: "user requested erasure under GDPR",
  });

  const afterDelete = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, TARGET),
  });
  check("the account row is gone", afterDelete === undefined);
  check(
    "the account's contacts are gone",
    (await db.query.contacts.findMany({ where: eq(contacts.userId, TARGET) })).length === 0
  );

  // The property that makes this auditable at all: purgeUserData deliberately spares the
  // audit log, so the record of the deletion outlives the account it describes.
  check(
    "the deletion audit row survives the deletion",
    (await auditRows("account.delete")).length === 1
  );
  const trail = await db.query.adminAuditLog.findMany({
    where: like(adminAuditLog.targetUserId, `${PREFIX}%`),
  });
  check(
    "the whole audit trail survives the deletion",
    trail.length >= 10,
    `${trail.length} rows`
  );

  /* --------------------------------------------------------------- the gate itself */

  // The lib takes the operator id as an argument; the gate that produces it lives in
  // `src/actions/admin.ts` and is covered by `scripts/smoke-admin-gate.ts`. What this
  // script can assert is that the guards consult the *live* allowlist, so removing an id
  // takes effect immediately rather than at the next deploy.
  process.env.ADMIN_USER_IDS = ADMIN;
  await refuses(
    "an id still on the allowlist is protected from deletion",
    () =>
      actions.deleteAccount(OTHER_OP, {
        targetUserId: ADMIN,
        confirmEmail: "x@example.test",
        reason: "should be refused",
      }),
    /operator account/i
  );

  process.env.ADMIN_USER_IDS = "";
  const { isAdminUser } = await import("../src/lib/admin");
  check(
    "clearing the allowlist revokes operator status immediately",
    isAdminUser(ADMIN) === false
  );

  console.log("Done.");
}

main()
  .then(async () => {
    await cleanup();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await cleanup().catch(() => {});
    process.exit(1);
  });
