/**
 * Genuine concurrency, which PGlite (one connection, serialized) cannot produce: many claims and
 * many credit reservations racing against real Postgres. Runs ONLY against a disposable Neon
 * branch named in OUTREACH_RACES_DATABASE_URL — never against the app's DATABASE_URL.
 *
 * Run: OUTREACH_RACES_DATABASE_URL=postgres://…branch… SMOKE_ALLOW_REMOTE=1 npx tsx scripts/smoke-outreach-races.ts
 */
import "./smoke/_env";

import { run } from "./smoke/_env";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  const target = process.env.OUTREACH_RACES_DATABASE_URL;
  if (!target || process.env.SMOKE_ALLOW_REMOTE !== "1") {
    console.error("PENDING: set OUTREACH_RACES_DATABASE_URL (a disposable Neon branch) and SMOKE_ALLOW_REMOTE=1");
    return;
  }
  process.env.DATABASE_URL = target;
  const { getDb } = await import("../src/db");
  const schema = await import("../src/db/schema");
  const { eq } = await import("drizzle-orm");
  const { claimJobs, enqueueJob } = await import("../src/lib/outreach/jobs/queue");
  const { chargeAttempt, ensureCreditAccount, reserveCredits } = await import("../src/lib/outreach/credits/ledger");
  const { ensureUserSettings } = await import("../src/lib/user-settings");

  const USER = `smoke-races-${Date.now()}`;
  const db = await getDb();
  await ensureUserSettings(USER);
  await db.update(schema.userSettings).set({ compedPlan: "orbit" }).where(eq(schema.userSettings.userId, USER));
  try {
    console.log("Twenty workers claim ten jobs...");
    const now = new Date();
    for (let i = 0; i < 10; i++) await enqueueJob({ userId: USER, kind: "ranking.batch", runAfter: now });
    const claims = await Promise.all(Array.from({ length: 20 }, (_, i) => claimJobs(`race-${i}`, 3, now, 60_000)));
    const ids = claims.flat().filter((j) => j.userId === USER).map((j) => j.id);
    check("every job was claimed exactly once", ids.length === 10 && new Set(ids).size === 10, `${ids.length} claims`);

    console.log("Ten reservations race for 250 credits...");
    await ensureCreditAccount(USER);
    const holds = await Promise.all(
      Array.from({ length: 10 }, (_, i) => reserveCredits(USER, { want: 30, min: 30, idempotencyKey: `race-${i}` }))
    );
    const won = holds.filter(Boolean);
    check("exactly eight 30-credit reservations fit in 250", won.length === 8, String(won.length));

    console.log("Ten charges race for one attempt...");
    const [campaign] = await db.insert(schema.outreachCampaigns).values({ userId: USER, name: "races", generation: 2 }).returning();
    const [prospect] = await db
      .insert(schema.outreachProspects)
      .values({ userId: USER, campaignId: campaign.id, externalId: "li:race", fullName: "Race" })
      .returning();
    const [attempt] = await db
      .insert(schema.outreachResearchAttempts)
      .values({ userId: USER, campaignId: campaign.id, prospectId: prospect.id, fundingSource: "orbit", creditState: "held", holdId: won[0]!.holdId })
      .returning();
    const charges = await Promise.all(Array.from({ length: 10 }, () => chargeAttempt(USER, attempt.id)));
    check("exactly one charge landed", charges.filter(Boolean).length === 1);
  } finally {
    const { purgeUserData } = await import("../src/lib/user-data");
    await purgeUserData(USER, { keepSettings: false }).catch(() => null);
  }
  console.log("All outreach race checks passed.");
}

run(main);
