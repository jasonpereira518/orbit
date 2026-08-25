/**
 * Exercises the admin console's data layer against the local PGlite database.
 *
 * Seeds accounts in every plan state that matters, then asserts the cross-user rollup,
 * plan resolution, funnel, alerts and the comp write path. Specifically guards the three
 * traps the query layer is most likely to fall into:
 *   - bigint SUMs arriving as strings and concatenating instead of adding
 *   - resolvePlan precedence (comp > lifetime > subscription > free)
 *   - the redaction allowlist letting an encrypted key or note through
 *
 * Run: npx tsx scripts/smoke-admin.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { eq, inArray, like } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  adminAuditLog,
  contacts,
  interactions,
  usageEvents,
  userSettings,
} from "../src/db/schema";
import { FREE_CONTACT_LIMIT } from "../src/lib/entitlements";
import {
  buildAlerts,
  buildFunnel,
  buildPlanBreakdown,
  loadAdminUserRows,
} from "../src/lib/admin-metrics";
import { ensureUserSettings, setCompedPlan } from "../src/lib/user-settings";

const PREFIX = "smoke-admin-";
const U = {
  comped: `${PREFIX}comped`,
  subscribed: `${PREFIX}subscribed`,
  pastDue: `${PREFIX}pastdue`,
  freeAtCap: `${PREFIX}freeatcap`,
  neverOnboarded: `${PREFIX}neveronboarded`,
  lifetime: `${PREFIX}lifetime`,
};

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

async function cleanup() {
  const db = await getDb();
  const ids = Object.values(U);
  await db.delete(usageEvents).where(inArray(usageEvents.userId, ids));
  await db.delete(interactions).where(inArray(interactions.userId, ids));
  await db.delete(contacts).where(inArray(contacts.userId, ids));
  await db.delete(adminAuditLog).where(like(adminAuditLog.targetUserId, `${PREFIX}%`));
  await db.delete(userSettings).where(inArray(userSettings.userId, ids));
}

async function seed() {
  const db = await getDb();

  for (const userId of Object.values(U)) {
    await ensureUserSettings(userId);
    await db
      .update(userSettings)
      .set({ email: `${userId}@example.test`, createdAt: ago(20) })
      .where(eq(userSettings.userId, userId));
  }

  // Comped Orbit Pro — comp must outrank the lapsed subscription below it.
  await setCompedPlan(U.comped, "orbit", {
    note: "beta feedback",
    adminUserId: "smoke-admin",
  });
  await db
    .update(userSettings)
    .set({ subscriptionPlan: "orbit", subscriptionStatus: "canceled", subscriptionPeriodEnd: ago(5) })
    .where(eq(userSettings.userId, U.comped));

  await db
    .update(userSettings)
    .set({
      subscriptionPlan: "orbit",
      subscriptionStatus: "active",
      subscriptionPeriodEnd: new Date(Date.now() + 20 * DAY),
      onboardingCompletedAt: ago(19),
      geminiApiKeyEncrypted: "ciphertext-not-a-real-key",
    })
    .where(eq(userSettings.userId, U.subscribed));

  await db
    .update(userSettings)
    .set({
      subscriptionPlan: "orbit",
      subscriptionStatus: "past_due",
      subscriptionPeriodEnd: new Date(Date.now() + 3 * DAY),
      onboardingCompletedAt: ago(18),
      geminiApiKeyEncrypted: "ciphertext-not-a-real-key",
    })
    .where(eq(userSettings.userId, U.pastDue));

  await db
    .update(userSettings)
    .set({ lifetimePurchasedAt: ago(10), onboardingCompletedAt: ago(10) })
    .where(eq(userSettings.userId, U.lifetime));

  await db
    .update(userSettings)
    .set({ onboardingCompletedAt: ago(15) })
    .where(eq(userSettings.userId, U.freeAtCap));

  // freeAtCap sits exactly on the free cap; neverOnboarded has nothing at all.
  const rows = Array.from({ length: FREE_CONTACT_LIMIT }, (_, i) => ({
    userId: U.freeAtCap,
    fullName: `Contact ${i}`,
  }));
  const capped = await db.insert(contacts).values(rows).returning();

  // interactions.contact_id is a required FK, so the subscriber needs a contact too.
  // That deliberately keeps "First contact" at 1 — see the funnel assertions below.
  const [subContact] = await db
    .insert(contacts)
    .values({ userId: U.subscribed, fullName: "Sub Contact" })
    .returning();

  // The comped account deliberately has a contact but NO onboarding_completed_at, so the
  // funnel's "onboarded" stage is forced to exercise the derived rule from
  // `needsOnboarding` rather than just reading the column.
  await db
    .insert(contacts)
    .values({ userId: U.comped, fullName: "Comped Contact" })
    .returning();

  await db.insert(interactions).values([
    {
      userId: U.freeAtCap,
      contactId: capped[0].id,
      interactionType: "note",
      interactionDate: ago(1),
    },
    {
      userId: U.subscribed,
      contactId: subContact.id,
      interactionType: "note",
      interactionDate: ago(2),
    },
  ]);

  // Token counts large enough that string concatenation would be unmistakable.
  await db.insert(usageEvents).values([
    {
      userId: U.subscribed,
      operation: "capture.parse",
      provider: "gemini",
      model: "gemini-3.5-flash",
      kind: "completion",
      keyOwner: "user",
      inputTokens: 2_000_000,
      outputTokens: 1_000_000,
      estimatedCostMicros: 3_100_000,
      success: 1,
    },
    {
      userId: U.subscribed,
      operation: "capture.parse",
      provider: "gemini",
      model: "gemini-3.5-flash",
      kind: "completion",
      keyOwner: "user",
      inputTokens: 3_000_000,
      outputTokens: 500_000,
      estimatedCostMicros: 2_150_000,
      success: 0,
      errorKind: "rate_limit",
    },
  ]);
}

async function main() {
  console.log("Seeding admin smoke fixtures…");
  await cleanup();
  await seed();

  const all = await loadAdminUserRows();
  const byId = new Map(all.map((r) => [r.userId, r]));
  const mine = Object.values(U).map((id) => {
    const row = byId.get(id);
    if (!row) throw new Error(`rollup missing row for ${id}`);
    return row;
  });

  console.log("\nPlan resolution");
  check("comp outranks a lapsed subscription", byId.get(U.comped)!.plan === "orbit");
  check("comp source is reported", byId.get(U.comped)!.planSource === "comp");
  check("comp note round-trips", byId.get(U.comped)!.compedNote === "beta feedback");
  check("active subscription resolves", byId.get(U.subscribed)!.planSource === "subscription");
  check("past_due keeps access", byId.get(U.pastDue)!.plan === "orbit");
  check("lifetime purchase resolves", byId.get(U.lifetime)!.planSource === "lifetime");
  check("no billing signal is free", byId.get(U.neverOnboarded)!.plan === "free");

  console.log("\nAggregates");
  const capped = byId.get(U.freeAtCap)!;
  check(
    `contact count is exact (${capped.counts.contacts})`,
    capped.counts.contacts === FREE_CONTACT_LIMIT
  );
  const sub = byId.get(U.subscribed)!;
  check(
    `token SUM adds, not concatenates (in=${sub.aiTokens.input})`,
    sub.aiTokens.input === 5_000_000
  );
  check(
    `output token SUM adds (out=${sub.aiTokens.output})`,
    sub.aiTokens.output === 1_500_000
  );
  check(
    `cost SUM adds (micros=${sub.estimatedCostMicros})`,
    sub.estimatedCostMicros === 5_250_000
  );
  check("typeof token total is number", typeof sub.aiTokens.input === "number");
  check(`ai call count (${sub.counts.aiCalls})`, sub.counts.aiCalls === 2);
  check(`ai failure count (${sub.counts.aiFailures})`, sub.counts.aiFailures === 1);
  check("usage timestamps feed lastSeenAt", sub.lastSeenAt !== null);

  console.log("\nKey configuration");
  check("configured key is detected", byId.get(U.subscribed)!.hasProviderKey === true);
  check("missing key is detected", byId.get(U.freeAtCap)!.hasProviderKey === false);

  console.log("\nFunnel");
  const funnel = buildFunnel(mine);
  const stage = (label: string) => funnel.find((s) => s.label === label)!.count;
  check(`signed up (${stage("Signed up")})`, stage("Signed up") === 6);
  check(
    `onboarded counts contact-havers without the flag (${stage("Onboarded")})`,
    stage("Onboarded") === 5
  );
  check(`first contact (${stage("First contact")})`, stage("First contact") === 3);
  check(`first interaction (${stage("First interaction")})`, stage("First interaction") === 2);

  console.log("\nPlan breakdown");
  const plans = buildPlanBreakdown(mine);
  check(`comped (${plans.comped})`, plans.comped === 1);
  check(`lifetime (${plans.lifetime})`, plans.lifetime === 1);
  check(`subscribed (${plans.subscribed})`, plans.subscribed === 2);
  check(`free (${plans.free})`, plans.free === 2);
  check("paid total is the sum of its parts", plans.paidTotal === 4);

  console.log("\nAlerts");
  const alerts = buildAlerts(mine);
  const msgFor = (userId: string) =>
    alerts.filter((a) => a.userId === userId).map((a) => a.message);
  check("past_due is flagged", msgFor(U.pastDue).some((m) => /past due/i.test(m)));
  check("free-at-cap is flagged", msgFor(U.freeAtCap).some((m) => /free cap/i.test(m)));
  check(
    "never-onboarded is flagged",
    msgFor(U.neverOnboarded).some((m) => /never onboarded/i.test(m))
  );
  check(
    "missing AI key is flagged",
    msgFor(U.freeAtCap).some((m) => /key configured/i.test(m))
  );
  check(
    "warnings sort above opportunities",
    alerts.findIndex((a) => a.severity === "warn") <
      alerts.findIndex((a) => a.severity === "opportunity")
  );

  console.log("\nComp write path");
  const revoked = await setCompedPlan(U.comped, null);
  check("revoking clears the plan", revoked.compedPlan === null);
  check("revoking clears the note", revoked.compedNote === null);
  check("revoking clears the timestamp", revoked.compedAt === null);

  const after = await loadAdminUserRows();
  const revokedRow = after.find((r) => r.userId === U.comped)!;
  check(
    "revoked account falls back to real billing state",
    revokedRow.plan === "free" && revokedRow.planSource === "free"
  );

  console.log("\nRedaction");
  const leaked = Object.entries(byId.get(U.subscribed)!).filter(([, v]) =>
    typeof v === "string" && v.includes("ciphertext")
  );
  check(
    "no encrypted key reaches the rollup",
    leaked.length === 0,
    leaked.map(([k]) => k).join(", ")
  );

  await cleanup();
  console.log("\nAll admin smoke checks passed.");
}

main()
  .then(() => {
    // The pooled DB connection keeps the event loop alive; exit explicitly.
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\n" + e.message);
    await cleanup().catch(() => {});
    process.exit(1);
  });
