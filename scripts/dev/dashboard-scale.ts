/**
 * How the dashboard loader scales with account size: wall time, statement count, and the
 * size of what it returns, at a few network sizes.
 *
 *   ORBIT_PGLITE_DIR=/tmp/orbit-scale npx tsx scripts/dev/dashboard-scale.ts seed
 *   ORBIT_PGLITE_DIR=/tmp/orbit-scale ORBIT_SIM_DB_LATENCY_MS=50 npx tsx scripts/dev/dashboard-scale.ts
 *
 * Seed once without latency (thousands of inserts at 50 ms each would take an hour), then
 * measure as often as you like. Use its own PGlite directory — never a dev server's.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../../src/db";
import { contacts, interactions, userSettings } from "../../src/db/schema";
import { getDashboardData } from "../../src/lib/reminders";
import { recalibrateCloseness } from "../../src/lib/closeness-cohort";
import { ensureUserSettings } from "../../src/lib/user-settings";
import { capturedQueries, startQueryCount, stopQueryCount } from "../../src/lib/query-counter";
import { scaleContactRows } from "../lib/scale-fixture";

const SIZES = [500, 3000, 10000];
const userFor = (n: number) => `dashboard-scale-${n}`;
const TYPES = ["email", "meeting", "note", "linkedin_message", "call"];

async function seed() {
  const db = await getDb();
  for (const n of SIZES) {
    const userId = userFor(n);
    await db.delete(interactions).where(eq(interactions.userId, userId));
    await db.delete(contacts).where(eq(contacts.userId, userId));
    await db.delete(userSettings).where(eq(userSettings.userId, userId));
    await ensureUserSettings(userId);
    const rows = scaleContactRows(userId, n, {
      inlineAvatarShare: 0.3,
      longNotesShare: 0.5,
      dueFollowUpRows: [Math.floor(n * 0.9)],
    });
    const ids: string[] = [];
    for (let start = 0; start < rows.length; start += 250) {
      const inserted = await db.insert(contacts).values(rows.slice(start, start + 250)).returning();
      ids.push(...inserted.map((r) => r.id));
    }
    // A realistic spread: most people a handful of touches, some none.
    const touches = ids.flatMap((contactId, i) =>
      Array.from({ length: i % 7 }, (_, k) => ({
        userId,
        contactId,
        interactionType: TYPES[(i + k) % TYPES.length],
        interactionDate: new Date(Date.now() - ((i * 13 + k * 29) % 400) * 86_400_000),
        externalId: `dashboard-scale-${n}-${i}-${k}`,
      }))
    );
    for (let start = 0; start < touches.length; start += 500) {
      await db.insert(interactions).values(touches.slice(start, start + 500));
    }
    // A real account has a materialized cohort; the first-ever visit is not the case to time.
    await recalibrateCloseness(userId);
    console.log(`seeded ${n} contacts, ${touches.length} interactions`);
  }
}

async function measure() {
  const latency = Number(process.env.ORBIT_SIM_DB_LATENCY_MS) || 0;
  await getDashboardData(userFor(SIZES[0])); // warm the module graph and the driver
  const rows = [];
  for (const n of SIZES) {
    const times: number[] = [];
    let statements = 0;
    let bytes = 0;
    for (let run = 0; run < 3; run++) {
      startQueryCount();
      const started = performance.now();
      const data = await getDashboardData(userFor(n));
      times.push(performance.now() - started);
      statements = capturedQueries().length;
      stopQueryCount();
      bytes = JSON.stringify(data, (_k, v) => (v instanceof Map ? [...v] : v instanceof Set ? [...v] : v)).length;
    }
    const median = [...times].sort((a, b) => a - b)[1];
    rows.push({
      contacts: n,
      median_ms: Math.round(median),
      statements,
      depth: latency ? Math.round((median / latency) * 10) / 10 : "-",
      payload_kb: Math.round(bytes / 1024),
    });
  }
  console.log(`simulated latency: ${latency} ms/statement`);
  console.table(rows);
}

(process.argv[2] === "seed" ? seed() : measure())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
