/**
 * Exercises the operations journal, issue lifecycle, provider cache/fallback contract,
 * retention, redaction, and failure isolation without contacting external providers.
 *
 * Run: npx tsx scripts/smoke-admin-operations-hub.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  adminIssues,
  adminProviderSnapshots,
  operationalEvents,
} from "../src/db/schema";
import {
  acknowledgeIssue,
  listAdminIssues,
  reconcileAdminIssues,
  snoozeIssue,
} from "../src/lib/admin-issues";
import {
  loadProviderStatuses,
  type ProviderName,
  type ProviderState,
  type ProviderStatus,
} from "../src/lib/admin-providers";
import {
  loadOperationalEvents,
  pruneOperationalEvents,
  recordOperationalEvent,
  sanitizeOperationalMetadata,
} from "../src/lib/operational-events";
import {
  previewStripeLifetimeReconciliation,
  reconcileClerkAccount,
  reconcileStripeLifetime,
} from "../src/lib/admin-reconciliation";

const PREFIX = "smoke-ops-";
const SOURCE = `${PREFIX}detector`;
const FINGERPRINT = `${PREFIX}issue`;
const USER = `${PREFIX}user`;

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function refuses(label: string, run: () => Promise<unknown>, match: RegExp) {
  let message = "";
  try {
    await run();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check(label, match.test(message), message || "operation was allowed");
}

function status(
  provider: ProviderName,
  state: ProviderState = "healthy"
): ProviderStatus {
  return {
    provider,
    label: provider[0].toUpperCase() + provider.slice(1),
    status: state,
    detail: `${provider} ${state}`,
    checkedAt: new Date(),
    stale: false,
    href: `https://example.test/${provider}`,
    metrics: { sample: 1 },
  };
}

const PROVIDERS: ProviderName[] = ["vercel", "neon", "clerk", "stripe"];
const healthyChecks = () => Object.fromEntries(
  PROVIDERS.map((provider) => [provider, async () => status(provider)])
) as Record<ProviderName, () => Promise<ProviderStatus>>;

async function main() {
  const db = await getDb();
  const originalSnapshots = await db.query.adminProviderSnapshots.findMany();

  try {
    await db.delete(operationalEvents).where(like(operationalEvents.eventType, `${PREFIX}%`));
    await db.delete(adminIssues).where(like(adminIssues.fingerprint, `${PREFIX}%`));
    await db.delete(adminProviderSnapshots);

    console.log("Operational metadata and journal");
    const metadata = sanitizeOperationalMetadata({
      provider: "stripe",
      attempts: 2,
      ok: false,
      secret: "never",
      request_body: "never",
      email: "never@example.test",
      nested: { forbidden: true },
      long_value: "x".repeat(500),
    });
    check("allowlisted scalar metadata survives", metadata.provider === "stripe" && metadata.attempts === 2);
    check("secret-bearing and contact keys are rejected", !("secret" in metadata) && !("email" in metadata));
    check("nested values are rejected", !("nested" in metadata));
    check("strings are bounded", String(metadata.long_value).length === 240);

    await Promise.all([
      recordOperationalEvent({
        severity: "info",
        source: "app",
        eventType: `${PREFIX}dedupe`,
        message: "A safe smoke event.",
        userId: USER,
        dedupeKey: `${PREFIX}dedupe-key`,
        metadata: { provider: "test" },
      }),
      recordOperationalEvent({
        severity: "info",
        source: "app",
        eventType: `${PREFIX}dedupe`,
        message: "A duplicate safe smoke event.",
        userId: USER,
        dedupeKey: `${PREFIX}dedupe-key`,
      }),
    ]);
    const deduped = await loadOperationalEvents({ eventType: `${PREFIX}dedupe` });
    check("concurrent writes deduplicate", deduped.rows.length === 1);

    await recordOperationalEvent({
      severity: "warn",
      source: "job",
      eventType: `${PREFIX}old`,
      message: "An expired smoke event.",
      occurredAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    check("retention removes expired events", (await pruneOperationalEvents()) >= 1);

    await recordOperationalEvent({
      severity: undefined as never,
      source: "app",
      eventType: `${PREFIX}invalid`,
      message: "This invalid insert must be isolated.",
    });
    check("telemetry database failures do not throw", true);

    console.log("\nIssue lifecycle");
    const detected = [{
      fingerprint: FINGERPRINT,
      source: SOURCE,
      severity: "error" as const,
      title: "Smoke issue",
      message: "A deterministic condition is active.",
      targetUserId: USER,
    }];
    await Promise.all([
      reconcileAdminIssues(SOURCE, detected),
      reconcileAdminIssues(SOURCE, detected),
    ]);
    let issue = (await listAdminIssues({ includeSnoozed: true })).find(
      (row) => row.fingerprint === FINGERPRINT
    );
    check("concurrent detection creates one issue", Boolean(issue) && issue?.occurrenceCount === 1);

    issue = await acknowledgeIssue(issue!.id, `${PREFIX}operator`);
    check("acknowledgement records actor and state", issue.state === "acknowledged" && issue.acknowledgedBy === `${PREFIX}operator`);
    issue = await snoozeIssue(issue.id, `${PREFIX}operator`, new Date(Date.now() + 60_000));
    check("active snooze derives the snoozed state", issue.state === "snoozed");

    await reconcileAdminIssues(SOURCE, []);
    issue = (await listAdminIssues({ includeResolved: true, includeSnoozed: true })).find(
      (row) => row.fingerprint === FINGERPRINT
    );
    check("missing detection automatically resolves", issue?.state === "resolved" && issue.resolvedAt != null);

    await Promise.all([
      reconcileAdminIssues(SOURCE, detected),
      reconcileAdminIssues(SOURCE, detected),
    ]);
    issue = (await listAdminIssues({ includeSnoozed: true })).find(
      (row) => row.fingerprint === FINGERPRINT
    );
    check("reopening increments one occurrence", issue?.state === "open" && issue.occurrenceCount === 2);
    check("reopening clears acknowledgement and snooze", issue?.acknowledgedAt == null && issue?.snoozedUntil == null);

    console.log("\nProvider cache and fallback");
    let providers = await loadProviderStatuses({ force: true, checks: healthyChecks() });
    check("all four connector results load in parallel", providers.every((item) => item.status === "healthy"));

    providers = await loadProviderStatuses({
      force: true,
      checks: {
        ...healthyChecks(),
        neon: async () => status("neon", "degraded"),
        clerk: async () => status("clerk", "unconfigured"),
      },
    });
    check("degraded state is preserved", providers.find((item) => item.provider === "neon")?.status === "degraded");
    check("unconfigured state is explicit", providers.find((item) => item.provider === "clerk")?.status === "unconfigured");

    providers = await loadProviderStatuses({
      force: true,
      checks: {
        ...healthyChecks(),
        vercel: async () => { throw new Error("HTTP 429"); },
      },
    });
    const stale = providers.find((item) => item.provider === "vercel");
    check("rate-limit failure uses last-known snapshot", stale?.stale === true && stale.status === "degraded");

    await db.delete(adminProviderSnapshots).where(eq(adminProviderSnapshots.provider, "vercel"));
    providers = await loadProviderStatuses({
      force: true,
      checks: {
        ...healthyChecks(),
        vercel: async () => { throw new Error("Vercel timed out"); },
      },
    });
    const timeout = providers.find((item) => item.provider === "vercel");
    check("timeout without cache is unavailable", timeout?.status === "unavailable" && timeout.metrics.errorKind === "timeout");

    await db.delete(adminProviderSnapshots).where(eq(adminProviderSnapshots.provider, "vercel"));
    providers = await loadProviderStatuses({
      force: true,
      checks: {
        ...healthyChecks(),
        vercel: async () => { throw new Error("Malformed response"); },
      },
    });
    check("malformed response is safely classified", providers.find((item) => item.provider === "vercel")?.metrics.errorKind === "request_failed");

    console.log("\nReconciliation refusal paths");
    await refuses(
      "Stripe requires an exact Checkout Session ID before any provider call",
      () => previewStripeLifetimeReconciliation(USER, "pi_not_a_checkout_session"),
      /exact Stripe Checkout Session ID/i
    );
    await refuses(
      "Clerk reconciliation requires a meaningful reason before any mutation",
      () => reconcileClerkAccount(`${PREFIX}operator`, { targetUserId: USER, reason: "" }),
      /at least 8/i
    );
    await refuses(
      "Stripe reconciliation requires a meaningful reason before any mutation",
      () => reconcileStripeLifetime(`${PREFIX}operator`, { targetUserId: USER, sessionId: "cs_test_fake", reason: "" }),
      /at least 8/i
    );

    console.log("\nAdmin operations hub smoke checks passed.");
  } finally {
    await db.delete(operationalEvents).where(like(operationalEvents.eventType, `${PREFIX}%`));
    await db.delete(operationalEvents).where(like(operationalEvents.dedupeKey, `${PREFIX}%`));
    await db.delete(adminIssues).where(like(adminIssues.fingerprint, `${PREFIX}%`));
    await db.delete(adminProviderSnapshots);
    if (originalSnapshots.length > 0) await db.insert(adminProviderSnapshots).values(originalSnapshots);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
