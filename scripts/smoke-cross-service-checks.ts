/**
 * Cross-service checks on the Health page.
 *
 * Each check holds two systems up against each other (Stripe vs account plans, open alerts
 * vs Slack, the build vs the database's schema version, Blob vs inlined avatars). What
 * matters is that a real disagreement shows up as one, that a clean database reads as clean,
 * and that a check which cannot run says `unknown` rather than `ok`.
 *
 * Run: npx tsx scripts/smoke-cross-service-checks.ts
 */
import "./smoke/_env";

import { eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { opsAlertState, userSettings } from "../src/db/schema";
import {
  alertDeliveryCheck,
  blobAvatarCheck,
  crossCheckIssues,
  getCrossServiceChecks,
  schemaVersionCheck,
  stripeChecks,
} from "../src/lib/admin-cross-checks";

const PREFIX = "smoke-xsvc-";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(userSettings).where(like(userSettings.userId, `${PREFIX}%`));
  await db.delete(opsAlertState).where(like(opsAlertState.id, `${PREFIX}%`));
}

async function main() {
  console.log("Cross-service checks");

  delete process.env.SLACK_OPS_WEBHOOK_URL;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  await cleanup();

  /* ------------------------------------------------------------------ the pure verdicts */

  check("schema: equal versions agree", schemaVersionCheck(10, 10).tone === "ok");
  check("schema: a database behind the build is the dangerous one", schemaVersionCheck(9, 10).tone === "danger");
  check("schema: a database ahead of the build is a rollback, a warning", schemaVersionCheck(11, 10).tone === "warn");
  check("schema: no recorded version is unknown, not ok", schemaVersionCheck(null, 10).tone === "unknown");

  check("blob: nothing inlined is ok either way", blobAvatarCheck(false, 0).tone === "ok" && blobAvatarCheck(true, 0).tone === "ok");
  check("blob: inlined photos warn, and say why", /not configured/.test(blobAvatarCheck(false, 3).summary) && /Blob is set up/.test(blobAvatarCheck(true, 3).summary));
  check("blob: an uncounted figure is unknown", blobAvatarCheck(true, null).tone === "unknown");

  check(
    "alerts: no Slack and an open alert is danger",
    alertDeliveryCheck({ slackConfigured: false, openAlerts: 1, unannounced: 1, unannouncedCritical: 0 }).tone === "danger"
  );
  check(
    "alerts: no Slack and nothing open is only a warning",
    alertDeliveryCheck({ slackConfigured: false, openAlerts: 0, unannounced: 0, unannouncedCritical: 0 }).tone === "warn"
  );
  check(
    "alerts: an unannounced critical is danger, a non-critical one a warning",
    alertDeliveryCheck({ slackConfigured: true, openAlerts: 1, unannounced: 1, unannouncedCritical: 1 }).tone === "danger" &&
      alertDeliveryCheck({ slackConfigured: true, openAlerts: 1, unannounced: 1, unannouncedCritical: 0 }).tone === "warn"
  );
  check(
    "alerts: every open alert announced is ok",
    alertDeliveryCheck({ slackConfigured: true, openAlerts: 2, unannounced: 0, unannouncedCritical: 0 }).tone === "ok"
  );

  const clean = stripeChecks({ checkouts: 0, noCustomer: 0, lapsed: 0 });
  check("stripe: zero counts are all ok", clean.length === 3 && clean.every((c) => c.tone === "ok"));
  const dirty = stripeChecks({ checkouts: 1, noCustomer: 2, lapsed: 3 });
  check(
    "stripe: a missing customer is danger; stuck checkouts and lapsed renewals warn",
    dirty.find((c) => c.id === "stripe-customer")?.tone === "danger" &&
      dirty.find((c) => c.id === "stripe-checkouts")?.tone === "warn" &&
      dirty.find((c) => c.id === "stripe-renewals")?.tone === "warn"
  );
  check("issue count counts warn and danger, not ok or unknown", crossCheckIssues([...dirty, ...clean]) === 3 && crossCheckIssues(null) === 0);

  /* --------------------------------------------------------- against a real (PGlite) database */

  const baseline = await getCrossServiceChecks({ inlinedAvatars: 0 });
  const byId = new Map(baseline.map((c) => [c.id, c]));
  check("a clean database reports every Stripe comparison ok", ["stripe-checkouts", "stripe-customer", "stripe-renewals"].every((id) => byId.get(id)?.tone === "ok"), baseline.map((c) => `${c.id}=${c.tone}`).join(" "));
  check("schema version agrees on a freshly migrated database", byId.get("schema-version")?.tone === "ok", byId.get("schema-version")?.summary);
  check("with Slack unset and nothing open, alert delivery warns", byId.get("alert-delivery")?.tone === "warn");

  const db = await getDb();
  const longAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  const hoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);

  await db.insert(userSettings).values([
    // Marked subscribed with no Stripe customer: the mirror is broken.
    { userId: `${PREFIX}no-customer`, subscriptionStatus: "active", subscriptionPlan: "orbit", subscriptionPeriodEnd: new Date(Date.now() + 86_400_000) },
    // Active, with a customer, but a renewal webhook was missed ten days ago.
    { userId: `${PREFIX}lapsed`, subscriptionStatus: "active", subscriptionPlan: "orbit", stripeCustomerId: `cus_${PREFIX}lapsed`, subscriptionPeriodEnd: longAgo },
    // A Lifetime checkout opened five hours ago that never resolved.
    { userId: `${PREFIX}checkout`, lifetimeCheckoutSessionId: `cs_${PREFIX}x`, lifetimeCheckoutStartedAt: hoursAgo },
  ]);
  await db.insert(opsAlertState).values({
    id: `${PREFIX}alert`,
    severity: "critical",
    active: true,
    openedAt: hoursAgo,
    lastSeenAt: new Date(),
    notifyCount: 0,
    detail: {},
  });

  const seeded = new Map((await getCrossServiceChecks({ inlinedAvatars: 4 })).map((c) => [c.id, c]));
  check("a subscribed account with no customer is counted", seeded.get("stripe-customer")?.count === 1 && seeded.get("stripe-customer")?.tone === "danger", JSON.stringify(seeded.get("stripe-customer")));
  check("an active subscription far past its period end is counted", seeded.get("stripe-renewals")?.count === 1, JSON.stringify(seeded.get("stripe-renewals")));
  check("a Lifetime checkout open for hours is counted", seeded.get("stripe-checkouts")?.count === 1, JSON.stringify(seeded.get("stripe-checkouts")));
  check("a critical alert open for hours with Slack unset is danger", seeded.get("alert-delivery")?.tone === "danger", JSON.stringify(seeded.get("alert-delivery")));
  check("inlined avatars are passed through to the Blob check", seeded.get("blob-avatars")?.count === 4);

  // A resolved checkout must stop counting: that is what the purchase webhook does.
  await db
    .update(userSettings)
    .set({ lifetimePurchasedAt: new Date() })
    .where(eq(userSettings.userId, `${PREFIX}checkout`));
  const resolved = new Map((await getCrossServiceChecks({ inlinedAvatars: 0 })).map((c) => [c.id, c]));
  check("a checkout that was credited stops counting", resolved.get("stripe-checkouts")?.tone === "ok");

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
