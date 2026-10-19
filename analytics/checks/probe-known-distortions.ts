/**
 * Seeded regression probe: reproduces, on FAKE data in a throwaway local PGlite database, the
 * places where Orbit's admin numbers used to mislead (ANALYTICS_AUDIT.md), and fails if any
 * fixed defect comes back. Before the analytics work 10 of its 12 claims reproduced.
 *
 * It never touches production: the smoke preamble deletes DATABASE_URL and points PGlite at
 * a temp directory. Nothing here is a unit test of intended behaviour — each probe states a
 * claim from ANALYTICS_AUDIT.md and prints whether the current code reproduces it.
 *
 * Run: npx tsx analytics/checks/probe-known-distortions.ts
 */
import "../../scripts/smoke/_env";

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "../../src/db";
import { pageViews } from "../../src/db/schema";
import { hashVisitor } from "../../src/lib/analytics-visitor";
import { acquisitionFunnel, trafficTotals, trafficTrend } from "../../src/lib/admin-analytics";
import { buildFunnel, loadAdminUserRows } from "../../src/lib/admin-metrics";
import {
  featureAdoption,
  growthSnapshot,
  rollingActiveTrend,
  userTotalsTrend,
  viewersTrend,
} from "../../src/lib/admin-trends";
import { TOUR_EXAMPLE_SOURCE } from "../../src/lib/onboarding-examples/marker";

process.env.ANALYTICS_SALT ??= "probe-salt-not-a-secret";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const now = new Date();
const ago = (ms: number) => new Date(now.getTime() - ms);

/**
 * `bug`: a defect the analytics work fixed; reproducing it again is a REGRESSION and fails the run.
 * `design`: a property of the cookieless approach that is documented on screen, not a defect.
 * `control`: a case that must keep behaving as it does.
 */
type Kind = "bug" | "design" | "control";
const results: Array<{ claim: string; reproduced: boolean; detail: string; kind: Kind }> = [];
function probe(claim: string, reproduced: boolean, detail: string, kind: Kind = "bug") {
  results.push({ claim, reproduced, detail, kind });
  const label = kind === "bug" ? (reproduced ? "REGRESSION " : "fixed      ") : kind === "design" ? (reproduced ? "by design  " : "changed?    ") : reproduced ? "holds      " : "BROKEN     ";
  console.log(`${label} ${claim}\n             ${detail}`);
}

async function main() {
  const db = await getDb();
  const uid = (k: string) => `probe_${k}_${randomUUID().slice(0, 8)}`;

  const user = async (id: string, createdAt: Date, extra: Record<string, unknown> = {}) => {
    await db.execute(sql`INSERT INTO user_settings (user_id, email, created_at)
      VALUES (${id}, ${`${id}@example.test`}, ${createdAt})`);
    for (const [k, v] of Object.entries(extra)) {
      await db.execute(sql`UPDATE user_settings SET ${sql.raw(k)} = ${v as string} WHERE user_id = ${id}`);
    }
  };
  const contact = async (userId: string, createdAt: Date, source: string | null = null) => {
    const r = await db.execute(sql`INSERT INTO contacts (user_id, full_name, source, created_at)
      VALUES (${userId}, 'Probe Person', ${source}, ${createdAt}) RETURNING id`);
    return ((r as unknown as { rows?: Array<{ id: string }> }).rows ?? (r as unknown as Array<{ id: string }>))[0]!.id;
  };
  const view = (userId: string | null, visitorHash: string, sessionId: string, route: string, createdAt: Date) =>
    db.insert(pageViews).values({
      id: randomUUID(), visitorHash, sessionId, userId, route, device: "desktop",
      isBot: false, isInternal: false, createdAt,
      referrerHost: null, utmSource: null, utmMedium: null, utmCampaign: null,
      country: null, region: null, city: null,
    });

  // ---------------------------------------------------------------------------------
  // 1. Visitor-days are not people.
  // One human, one device, one IP, visiting on three consecutive UTC days.
  // ---------------------------------------------------------------------------------
  {
    const before = await trafficTotals("7d", now);
    for (let d = 1; d <= 3; d++) {
      const at = ago(d * DAY);
      await view(null, hashVisitor("203.0.113.7", "UA-same-laptop", at), randomUUID(), "/", at);
    }
    const after = await trafficTotals("7d", now);
    const delta = after.visitorDays - before.visitorDays;
    probe(
      "A1: one person on three days is reported as three 'unique' visitor-days",
      delta === 3,
      `trafficTotals.visitorDays rose by ${delta} for ONE person (hash rotates at UTC midnight; no key joins the days)`,
      "design"
    );
  }

  // ---------------------------------------------------------------------------------
  // 2. One session straddling UTC midnight becomes two visitor-days AND two hashes.
  // ---------------------------------------------------------------------------------
  {
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const beforeMidnight = new Date(midnight.getTime() - 10 * 60_000);
    const afterMidnight = new Date(midnight.getTime() + 10 * 60_000);
    const sid = randomUUID();
    const before = await trafficTotals("7d", now);
    await view(null, hashVisitor("203.0.113.8", "UA-night-owl", beforeMidnight), sid, "/pricing", beforeMidnight);
    await view(null, hashVisitor("203.0.113.8", "UA-night-owl", afterMidnight), sid, "/sign-up/[[...sign-up]]", afterMidnight);
    const after = await trafficTotals("7d", now);
    probe(
      "A2: a single session across UTC midnight counts as two visitor-days",
      after.visitorDays - before.visitorDays === 2 && after.sessions - before.sessions === 1,
      `visitorDays +${after.visitorDays - before.visitorDays}, sessions +${after.sessions - before.sessions}`,
      "design"
    );
  }

  // ---------------------------------------------------------------------------------
  // 3. Internal (admin) accounts are excluded from traffic and the conversion funnel but
  //    NOT from the Growth page's active-user, feature-adoption, or /admin funnel numbers.
  // ---------------------------------------------------------------------------------
  {
    const admin = uid("admin");
    const savedAdmins = process.env.ADMIN_USER_IDS;
    process.env.ADMIN_USER_IDS = admin;
    await user(admin, ago(30 * DAY));

    const snapBefore = await growthSnapshot(7);
    const adoptBefore = await featureAdoption();
    const rollBefore = await rollingActiveTrend("day", 3);
    const viewersBefore = await viewersTrend("day", 3);

    await contact(admin, ago(2 * HOUR));
    await db.execute(sql`INSERT INTO capture_jobs (user_id, source_kind, status, created_at)
      VALUES (${admin}, 'text', 'saved', ${ago(2 * HOUR)})`);
    await view(admin, hashVisitor("198.51.100.1", "UA-admin", now), randomUUID(), "/dashboard", ago(HOUR));

    const snapAfter = await growthSnapshot(7);
    const adoptAfter = await featureAdoption();
    const rollAfter = await rollingActiveTrend("day", 3);
    const viewersAfter = await viewersTrend("day", 3);
    const last = <T>(xs: T[]) => xs[xs.length - 1]!;
    const captureCount = (rows: Awaited<ReturnType<typeof featureAdoption>>) =>
      rows.find((r) => r.key === "capture")?.count ?? 0;

    probe(
      "B1: an admin account counts toward Growth's DAU/WAU/MAU",
      snapAfter.dau - snapBefore.dau === 1 && last(rollAfter).wau - last(rollBefore).wau === 1,
      `growthSnapshot.dau +${snapAfter.dau - snapBefore.dau}, rollingActiveTrend.wau +${last(rollAfter).wau - last(rollBefore).wau} (writesSince() has no internal filter)`
    );
    probe(
      "B2: an admin account counts toward 'Accounts that have used each feature'",
      captureCount(adoptAfter) - captureCount(adoptBefore) === 1,
      `featureAdoption.capture +${captureCount(adoptAfter) - captureCount(adoptBefore)}`
    );
    probe(
      "B3 (control): the same admin is correctly excluded from 'Opened Orbit' (viewersTrend)",
      last(viewersAfter).viewers - last(viewersBefore).viewers === 0,
      `viewersTrend.viewers +${last(viewersAfter).viewers - last(viewersBefore).viewers}`,
      "control"
    );

    const rows = await loadAdminUserRows();
    const adminRow = rows.find((r) => r.userId === admin);
    probe(
      "B4: /admin overview's Activation funnel (buildFunnel) includes admin accounts",
      Boolean(adminRow) && buildFunnel(rows.filter((r) => r.userId === admin))[3]!.count === 1,
      `loadAdminUserRows returned the admin row: ${Boolean(adminRow)}`
    );

    if (savedAdmins === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = savedAdmins;
  }

  // ---------------------------------------------------------------------------------
  // 4. Tour example people make an account look activated on /admin but not on the
  //    Conversion page — two activation definitions in two places.
  // ---------------------------------------------------------------------------------
  {
    const tour = uid("tour");
    await user(tour, ago(10 * DAY)); // mature for the funnel's 7-day rule
    for (let i = 0; i < 8; i++) await contact(tour, ago(10 * DAY), TOUR_EXAMPLE_SOURCE);

    const rows = (await loadAdminUserRows()).filter((r) => r.userId === tour);
    const overview = buildFunnel(rows);
    const onboarded = overview.find((s) => s.label === "Onboarded")!.count;
    const firstContact = overview.find((s) => s.label === "First contact")!.count;
    probe(
      "C1: /admin counts an account with ONLY tour examples as Onboarded + First contact",
      onboarded === 1 && firstContact === 1,
      `buildFunnel: Onboarded=${onboarded}, First contact=${firstContact} (counts.contacts ignores contacts.source)`
    );

    // The Conversion page applies the opposite rule for the same account.
    const savedAdmins = process.env.ADMIN_USER_IDS;
    delete process.env.ADMIN_USER_IDS;
    const funnelBefore = await acquisitionFunnel("30d", now);
    // Add a second, identical account so the delta is unambiguous.
    const tour2 = uid("tour2");
    await user(tour2, ago(10 * DAY));
    for (let i = 0; i < 8; i++) await contact(tour2, ago(10 * DAY), TOUR_EXAMPLE_SOURCE);
    const funnelAfter = await acquisitionFunnel("30d", now);
    const activatedDelta =
      funnelAfter.find((s) => s.label === "Activated")!.count - funnelBefore.find((s) => s.label === "Activated")!.count;
    probe(
      "C2: /admin and /admin/analytics/funnel disagree about that same account",
      !(activatedDelta === 0 && onboarded === 0),
      `overview Onboarded=${onboarded}, acquisitionFunnel.Activated +${activatedDelta}`
    );
    if (savedAdmins !== undefined) process.env.ADMIN_USER_IDS = savedAdmins;
  }

  // ---------------------------------------------------------------------------------
  // 5. Background writes count as "active": a calendar-synced interaction or a nightly
  //    Radar AI call makes a dormant account a DAU.
  // ---------------------------------------------------------------------------------
  {
    const dormant = uid("dormant");
    await user(dormant, ago(40 * DAY));
    const c = await contact(dormant, ago(40 * DAY));
    const before = await growthSnapshot(7);
    await db.execute(sql`INSERT INTO interactions (user_id, contact_id, external_id, created_at)
      VALUES (${dormant}, ${c}, 'cal-evt-probe', ${ago(HOUR)})`);
    const mid = await growthSnapshot(7);
    const dormant2 = uid("dormant2");
    await user(dormant2, ago(40 * DAY));
    await db.execute(sql`INSERT INTO usage_events (user_id, operation, provider, model, kind, key_owner, success, created_at)
      VALUES (${dormant2}, 'radar.nightly', 'gemini', 'probe-model', 'text', 'orbit', 1, ${ago(HOUR)})`);
    const after = await growthSnapshot(7);
    probe(
      "D1: a calendar-sync write alone makes a dormant account a DAU",
      mid.dau - before.dau === 1,
      `growthSnapshot.dau +${mid.dau - before.dau} from one interactions row with external_id`
    );
    probe(
      "D2: a cron-driven AI call (usage_events) alone makes a dormant account a DAU",
      after.dau - mid.dau === 1,
      `growthSnapshot.dau +${after.dau - mid.dau} from one usage_events row the user never triggered`
    );
  }

  // ---------------------------------------------------------------------------------
  // 6. Survivorship: deleting an account rewrites history on 'Accounts over time'.
  // ---------------------------------------------------------------------------------
  {
    const gone = uid("gone");
    await user(gone, ago(45 * DAY));
    const before = await userTotalsTrend("week", 12);
    await db.execute(sql`DELETE FROM user_settings WHERE user_id = ${gone}`);
    const after = await userTotalsTrend("week", 12);
    const addedBefore = before.reduce((n, p) => n + p.added, 0);
    const addedAfter = after.reduce((n, p) => n + p.added, 0);
    const lastTotalDrop = before[before.length - 1]!.total - after[after.length - 1]!.total;
    probe(
      "E1: account deletion rewrites PAST 'new accounts' bars; churn never appears anywhere",
      addedBefore - addedAfter === 1 && lastTotalDrop === 1,
      `'added' across past buckets fell by ${addedBefore - addedAfter}; running total fell by ${lastTotalDrop}. Past bars shrink by design (a deleted account is gone); churn is recorded in the ledger instead`,
      "design"
    );
  }

  // ---------------------------------------------------------------------------------
  // 7. Chart bars vs headline: trend buckets use the session time zone, the headline uses UTC.
  //    Only observable when the DB session is not UTC; recorded here as a latent risk.
  // ---------------------------------------------------------------------------------
  {
    const tz = ((await db.execute(sql`SHOW TimeZone`)) as unknown as { rows?: Array<{ TimeZone: string }> }).rows?.[0]?.TimeZone;
    const trend = await trafficTrend("7d");
    const totals = await trafficTotals("7d", now);
    const barSum = trend.reduce((n, p) => n + p.visitorDays, 0);
    probe(
      "F1: per-bucket visitor-days can exceed the headline when the DB session is not UTC",
      tz !== "UTC" && barSum !== totals.visitorDays,
      `session TimeZone=${tz}; bars sum to ${barSum}, headline ${totals.visitorDays} (trafficTrend uses date_trunc without AT TIME ZONE 'UTC')`
    );
  }

  const regressions = results.filter((r) => (r.kind === "bug" && r.reproduced) || (r.kind === "control" && !r.reproduced));
  console.log(`\n${results.length} probes, ${regressions.length} regression(s).`);
  if (regressions.length > 0) process.exitCode = 1;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
