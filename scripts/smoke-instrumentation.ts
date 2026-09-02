/**
 * Exercises the admin console's instrumentation layer against the local PGlite database:
 * the cron ledger, connection health, the webhook delivery ledger, and error events.
 *
 * The assertions are chosen around the ways each piece silently stops working:
 *   - a cron row written only at the END makes crashed runs invisible again
 *   - `isRefreshRejection` returning true for a transport error would flag every account
 *     during a provider outage
 *   - a unique index on (source, event_id) would quietly eat the webhook retry count
 *   - instrumenting the already-instrumented embedding sites would double-count failures
 *
 * Run: npx tsx scripts/smoke-instrumentation.ts
 */
import "./smoke/_env";

import { eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  cronRuns,
  errorEvents,
  gmailConnections,
  userSettings,
  webhookDeliveries,
} from "../src/db/schema";
import {
  deriveCronRunState,
  finishCronRun,
  hasMissedRun,
  startCronRun,
} from "../src/lib/cron-runs";
import { isRefreshRejection } from "../src/lib/errors";
import { upsertGmailConnection } from "../src/lib/gmail";
import { recordWebhookDelivery, WEBHOOK_REASONS } from "../src/lib/webhook-deliveries";
import { recordErrorEvent, shouldRecordThrottled } from "../src/lib/error-events";
import { getAdminUserDetail } from "../src/lib/admin-user-detail";
import { buildAlerts, loadAdminUserRows } from "../src/lib/admin-metrics";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-instr-user";
const DRIFT_USER = "smoke-instr-drift";
const JOB = "imports.process-stalled" as const;
const SOURCE = "smoke.instrumentation";
const EVENT_ID = "svix-smoke-00000001";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(cronRuns).where(eq(cronRuns.job, JOB));
  await db.delete(webhookDeliveries).where(like(webhookDeliveries.eventId, "svix-smoke-%"));
  await db.delete(errorEvents).where(like(errorEvents.source, "smoke.%"));
  await db.delete(errorEvents).where(eq(errorEvents.userId, USER));
  await db.delete(gmailConnections).where(eq(gmailConnections.userId, USER));
  for (const u of [USER, DRIFT_USER]) {
    await db.delete(userSettings).where(eq(userSettings.userId, u));
  }
}

async function main() {
  await cleanup();
  const db = await getDb();

  console.log("Cron ledger");
  {
    const run = await startCronRun(JOB);
    check("startCronRun returns an id", typeof run.id === "string");

    const [opened] = await db
      .select()
      .from(cronRuns)
      .where(eq(cronRuns.id, run.id!));
    // The whole point of writing at start: without this, a run killed at maxDuration is
    // indistinguishable from a run that never fired.
    check("opens as running", opened.status === "running");
    check("finished_at is null while running", opened.finishedAt === null);
    check("duration is null while running", opened.durationMs === null);

    await finishCronRun(run, {
      status: "partial",
      stats: { stalledFound: 3, resumed: 2, resumeFailed: 1, usageEventsPruned: 7 },
    });
    const [closed] = await db.select().from(cronRuns).where(eq(cronRuns.id, run.id!));
    check("records partial", closed.status === "partial");
    check("records finished_at", closed.finishedAt !== null);
    check("records a duration", typeof closed.durationMs === "number");
    // Partial failure must not throw away the work that did succeed.
    check("partial run keeps its success count", closed.stats.resumed === 2);
    check("stats round-trip as an object", typeof closed.stats === "object");
    check("prune count is recorded", closed.stats.usageEventsPruned === 7);

    const now = new Date();
    const long = new Date(now.getTime() - 30 * 60 * 1000);
    const recent = new Date(now.getTime() - 60 * 1000);
    check(
      "a long-running row reads as stale",
      deriveCronRunState({ status: "running", startedAt: long, finishedAt: null }, now) ===
        "stale"
    );
    check(
      "a fresh row still reads as running",
      deriveCronRunState({ status: "running", startedAt: recent, finishedAt: null }, now) ===
        "running"
    );
    check(
      "a finished row keeps its own status",
      deriveCronRunState({ status: "ok", startedAt: long, finishedAt: now }, now) === "ok"
    );

    check("never having run counts as missed", hasMissedRun(null, now) === true);
    check("a run 30h ago counts as missed", hasMissedRun(new Date(now.getTime() - 30 * 3600_000), now) === true);
    check("a run 2h ago does not", hasMissedRun(new Date(now.getTime() - 2 * 3600_000), now) === false);

    // A ledger failure must degrade, never throw.
    await finishCronRun({ id: null, startedAt: Date.now() }, { status: "ok" });
    check("finishing a null handle is a no-op", true);
  }

  console.log("\nRefresh-rejection classifier");
  {
    check(
      "google invalid_grant is a rejection",
      isRefreshRejection(400, '{"error":"invalid_grant"}') === true
    );
    check(
      "401 unauthorized_client is a rejection",
      isRefreshRejection(401, '{"error":"unauthorized_client"}') === true
    );
    // These are the important ones. A provider outage must NOT mark every account.
    check(
      "a 503 is not a rejection",
      isRefreshRejection(503, "upstream unavailable") === false
    );
    check(
      "a 500 is not a rejection",
      isRefreshRejection(500, "internal error") === false
    );
    check(
      "400 temporarily_unavailable is not a rejection",
      isRefreshRejection(400, '{"error":"temporarily_unavailable"}') === false
    );
  }

  console.log("\nConnection health");
  {
    await ensureUserSettings(USER);
    await upsertGmailConnection(
      USER,
      { access_token: "at", refresh_token: "rt", expires_in: 3600 },
      `${USER}@example.test`
    );
    const [fresh] = await db
      .select()
      .from(gmailConnections)
      .where(eq(gmailConnections.userId, USER));
    check("a new connection is active", fresh.status === "active");

    await db
      .update(gmailConnections)
      .set({ status: "needs_reauth" })
      .where(eq(gmailConnections.userId, USER));

    // The dead-code-resurrection assertion: before `needs_reauth` was ever written, this
    // branch in admin-user-detail.ts could not fire at all.
    const detail = await getAdminUserDetail(USER);
    const connectionIssue = detail?.health.find((h) => h.kind === "connection");
    check(
      "the inspector surfaces a needs_reauth connection",
      Boolean(connectionIssue),
      JSON.stringify(detail?.health ?? [])
    );
    check(
      "and it reads as an error",
      connectionIssue?.severity === "error"
    );

    // Reconnecting is the only path back, and it must actually clear the flag.
    await upsertGmailConnection(
      USER,
      { access_token: "at2", refresh_token: "rt2", expires_in: 3600 },
      `${USER}@example.test`
    );
    const [recovered] = await db
      .select()
      .from(gmailConnections)
      .where(eq(gmailConnections.userId, USER));
    check("reconnecting clears needs_reauth", recovered.status === "active");

    const after = await getAdminUserDetail(USER);
    check(
      "a healthy connection raises nothing",
      !after?.health.some((h) => h.kind === "connection")
    );
  }

  console.log("\nWebhook ledger");
  {
    await recordWebhookDelivery({
      eventId: EVENT_ID,
      eventType: "user.created",
      outcome: "handled",
      targetUserId: USER,
      resourceId: USER,
    });
    await recordWebhookDelivery({
      eventId: EVENT_ID,
      eventType: "user.created",
      outcome: "handled",
      targetUserId: USER,
    });
    const retries = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.eventId, EVENT_ID));
    // If someone adds a unique index on (source, event_id), this drops to 1 and the retry
    // count — the ledger's single best signal — is silently gone.
    check(`the same event id records twice (${retries.length})`, retries.length === 2);

    await recordWebhookDelivery({
      eventId: "svix-smoke-00000002",
      eventType: null,
      outcome: "invalid",
      reason: WEBHOOK_REASONS.signatureInvalid,
      error: new Error("no matching signature"),
    });
    const [invalid] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.eventId, "svix-smoke-00000002"));
    check("a rejected delivery is recordable with no event type", invalid.eventType === null);
    check("and keeps its delivery id", invalid.eventId === "svix-smoke-00000002");
    check("and stores the reason", invalid.reason === WEBHOOK_REASONS.signatureInvalid);
    check("and stores the error", Boolean(invalid.error));

    await recordWebhookDelivery({
      eventId: "svix-smoke-00000003",
      eventType: "subscriptionItem.updated",
      outcome: "ignored",
      reason: WEBHOOK_REASONS.otherPlanSlug,
      detail: { slug: "some-other-product", status: "active" },
    });
    const [ignored] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.eventId, "svix-smoke-00000003"));
    check("an ignored billing event records its reason", ignored.reason === WEBHOOK_REASONS.otherPlanSlug);
    check("detail round-trips as an object", typeof ignored.detail === "object");
    check("with no target user", ignored.targetUserId === null);

    // Must survive garbage without throwing — it runs on the response path of a webhook.
    await recordWebhookDelivery({
      eventId: "svix-smoke-00000004",
      outcome: "error",
      error: new Error("x".repeat(5000)),
    });
    const [huge] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.eventId, "svix-smoke-00000004"));
    check(
      `a long error is truncated (${huge.error?.length})`,
      (huge.error?.length ?? 0) <= 500
    );
  }

  console.log("\nBilling drift detector");
  {
    await ensureUserSettings(DRIFT_USER);
    await db
      .update(userSettings)
      .set({
        email: `${DRIFT_USER}@example.test`,
        subscriptionPlan: "orbit",
        subscriptionStatus: "active",
        subscriptionPeriodEnd: new Date(Date.now() - 10 * 24 * 3600_000),
      })
      .where(eq(userSettings.userId, DRIFT_USER));

    const rows = await loadAdminUserRows();
    const mine = rows.filter((r) => r.userId === DRIFT_USER);
    const alerts = buildAlerts(mine);
    check(
      "an active subscription paid through the past is flagged",
      alerts.some((a) => /webhook was probably missed/i.test(a.message)),
      JSON.stringify(alerts)
    );
  }

  console.log("\nError events");
  {
    await recordErrorEvent({
      source: SOURCE,
      kind: "test_kind",
      userId: USER,
      message: new Error("y".repeat(5000)),
      context: { attempts: 3 },
    });
    const [row] = await db
      .select()
      .from(errorEvents)
      .where(eq(errorEvents.source, SOURCE));
    check("source and kind round-trip", row.kind === "test_kind");
    check("user id round-trips", row.userId === USER);
    check("context round-trips as an object", typeof row.context === "object");
    check("context values survive", (row.context as { attempts?: number }).attempts === 3);
    check(`message is truncated (${row.message?.length})`, (row.message?.length ?? 0) <= 500);

    await recordErrorEvent({ source: `${SOURCE}.null`, kind: "no_user" });
    const [nullUser] = await db
      .select()
      .from(errorEvents)
      .where(eq(errorEvents.source, `${SOURCE}.null`));
    check("a failure with no user is legal", nullUser.userId === null);

    const key = "smoke-throttle-key";
    check("the first throttled call records", shouldRecordThrottled(key) === true);
    check("an immediate repeat does not", shouldRecordThrottled(key) === false);

    // Guard against someone later "helpfully" instrumenting the embedding sites in
    // search.ts, which already write a usage_events row with success = 0.
    const embedRows = await db
      .select()
      .from(errorEvents)
      .where(like(errorEvents.source, "search.embed%"));
    check(
      "the already-instrumented embedding sites write no error events",
      embedRows.length === 0,
      `${embedRows.length} rows`
    );
  }

  console.log("\nRecruiter counter drift");
  {
    // purgeUserData must recompute the shared directory's denormalized counters; without
    // that, every account deletion permanently inflates them.
    const src = await import("../src/lib/user-data");
    check(
      "purgeUserData recomputes recruiter ratings",
      src.purgeUserData.toString().includes("recomputeRecruiterRating")
    );
  }

  await cleanup();
  console.log("\nAll instrumentation checks passed.");
}

main()
  .then(() => {
    // The pooled DB connection keeps the event loop alive; exit explicitly.
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nFAILED:", e.message);
    await cleanup().catch(() => {});
    process.exit(1);
  });
