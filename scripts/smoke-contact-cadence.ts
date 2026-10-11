import "./smoke/_env";
/**
 * The effective-cadence rule in TypeScript (`keep-in-touch.ts`) and in SQL
 * (`contact-cadence-sql.ts`) agree, contact by contact, on a fixture covering every branch.
 * Run: npx tsx scripts/smoke-contact-cadence.ts
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import {
  KEEP_IN_TOUCH_MAX_DAYS, KEEP_IN_TOUCH_PRESETS, normalizeCadence,
  cadenceDueAt, cadenceName, effectiveCadenceDays, isFollowUpDue, isTierDefaultCadence,
} from "../src/lib/keep-in-touch";
import { cadenceDueAtSql, effectiveCadenceSql, followUpDueSql } from "../src/lib/contact-cadence-sql";

const USER = "smoke-contact-cadence";
let failures = 0;
const check = (label: string, ok: boolean) => { if (ok) console.log(`  ok   ${label}`); else { failures++; console.error(`  FAIL ${label}`); } };
const DAY = 86_400_000;
// Whole milliseconds: a JS Date has no finer grain, and the column keeps what it is given.
const now = new Date();
const ago = (d: number) => new Date(now.getTime() - d * DAY);
const ahead = (d: number) => new Date(now.getTime() + d * DAY);

async function main() {
  console.log("pure rule");
  check("own cadence wins", effectiveCadenceDays({ cadenceDays: 14, closenessTier: "inner" }) === 14);
  check("inner defaults monthly", effectiveCadenceDays({ cadenceDays: null, closenessTier: "inner", closenessEvidence: 0.5 }) === 30);
  check("mid defaults quarterly", effectiveCadenceDays({ cadenceDays: null, closenessTier: "mid", closenessEvidence: 0.5 }) === 90);
  check("outer has none", effectiveCadenceDays({ cadenceDays: null, closenessTier: "outer", closenessEvidence: 0.5 }) === null);
  check("no tier has none", effectiveCadenceDays({ cadenceDays: null, closenessTier: null, closenessEvidence: 0.5 }) === null);
  check("a tier on thin evidence gives no default", effectiveCadenceDays({ cadenceDays: null, closenessTier: "inner", closenessEvidence: 0.1 }) === null);
  check("a tier with unknown evidence gives no default", effectiveCadenceDays({ cadenceDays: null, closenessTier: "inner" }) === null);
  check("own cadence needs no evidence", effectiveCadenceDays({ cadenceDays: 14, closenessTier: "inner", closenessEvidence: null }) === 14);
  check("tier default flagged", isTierDefaultCadence({ cadenceDays: null, closenessTier: "inner", closenessEvidence: 0.5 }));
  check("thin-evidence tier not flagged", !isTierDefaultCadence({ cadenceDays: null, closenessTier: "inner", closenessEvidence: 0.1 }));
  check("own cadence not flagged", !isTierDefaultCadence({ cadenceDays: 30, closenessTier: "inner" }));
  check("names", [30, 90, 180, 365, 7, 14, 45].map(cadenceName).join("|") === "Monthly|Quarterly|Twice a year|Yearly|Weekly|Every 2 weeks|Every 45 days");
  check("future follow-up blocks cadence-due",
    !isFollowUpDue({ cadenceDays: 30, closenessTier: null, lastInteractionAt: ago(40), nextFollowUpAt: ahead(3) }, now));
  check("lapsed cadence is due", isFollowUpDue({ cadenceDays: 30, closenessTier: null, lastInteractionAt: ago(31), nextFollowUpAt: null }, now));
  check("unlapsed cadence is not due", !isFollowUpDue({ cadenceDays: 30, closenessTier: null, lastInteractionAt: ago(29), nextFollowUpAt: null }, now));
  check("no touch falls back to date met",
    cadenceDueAt({ cadenceDays: 30, closenessTier: null, lastInteractionAt: null, dateMet: ago(10), createdAt: ago(100), nextFollowUpAt: null })!.getTime() === ago(10).getTime() + 30 * DAY);

  console.log("normalizeCadence is the only gate on what gets stored");
  check("rejects zero", normalizeCadence(0) === null);
  check("rejects negatives", normalizeCadence(-1) === null);
  check("rejects NaN", normalizeCadence(Number.NaN) === null);
  check("rejects Infinity", normalizeCadence(Number.POSITIVE_INFINITY) === null);
  check("rejects junk strings", normalizeCadence("soon") === null);
  check("rejects past the ceiling", normalizeCadence(KEEP_IN_TOUCH_MAX_DAYS + 1) === null);
  check("accepts the ceiling itself", normalizeCadence(KEEP_IN_TOUCH_MAX_DAYS) === KEEP_IN_TOUCH_MAX_DAYS);
  check("accepts a numeric string from a form field", normalizeCadence("90") === 90);
  check("rounds a fraction rather than storing it", normalizeCadence(90.4) === 90);
  check("every preset survives its own validator", KEEP_IN_TOUCH_PRESETS.every((p) => normalizeCadence(p.days) === p.days));

  console.log("SQL twin agrees");
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  const FIXTURE = [
    { fullName: "Own 30 lapsed", cadenceDays: 30, closenessTier: "outer", lastInteractionAt: ago(31) },
    { fullName: "Own 30 fresh", cadenceDays: 30, closenessTier: "outer", lastInteractionAt: ago(5) },
    { fullName: "Inner default lapsed", closenessEvidence: 0.5, cadenceDays: null, closenessTier: "inner", lastInteractionAt: ago(31) },
    { fullName: "Mid default fresh", closenessEvidence: 0.5, cadenceDays: null, closenessTier: "mid", lastInteractionAt: ago(60) },
    { fullName: "Outer none", cadenceDays: null, closenessTier: "outer", lastInteractionAt: ago(400) },
    { fullName: "Scheduled ahead", cadenceDays: 30, closenessTier: "inner", lastInteractionAt: ago(90), nextFollowUpAt: ahead(2) },
    { fullName: "Scheduled due", cadenceDays: 30, closenessTier: "inner", lastInteractionAt: ago(90), nextFollowUpAt: ago(1) },
    { fullName: "No touch, date met", cadenceDays: 14, closenessTier: null, lastInteractionAt: null, dateMet: ago(20) },
    { fullName: "No anchor, created fallback", cadenceDays: 30, closenessTier: null, lastInteractionAt: null },
    { fullName: "Zero cadence inner default", closenessEvidence: 0.5, cadenceDays: 0, closenessTier: "inner", lastInteractionAt: ago(31) },
    { fullName: "Inner thin evidence lapsed", cadenceDays: null, closenessTier: "inner", closenessEvidence: 0.1, lastInteractionAt: ago(31) },
    { fullName: "Inner evidenced lapsed", cadenceDays: null, closenessTier: "inner", closenessEvidence: 0.5, lastInteractionAt: ago(31) },
    { fullName: "Own 14 null evidence", cadenceDays: 14, closenessTier: "inner", closenessEvidence: null, lastInteractionAt: ago(15) },
    { fullName: "No cadence no tier", cadenceDays: null, closenessTier: null, lastInteractionAt: ago(400) },
  ] as const;
  const ids: string[] = [];
  try {
    for (const f of FIXTURE) {
      const [row] = await db.insert(contacts).values({ userId: USER, ...f } as typeof contacts.$inferInsert).returning();
      ids.push(row.id);
    }
    const rows = await db.select({
      id: contacts.id, fullName: contacts.fullName, cadenceDays: contacts.cadenceDays, closenessTier: contacts.closenessTier, closenessEvidence: contacts.closenessEvidence,
      lastInteractionAt: contacts.lastInteractionAt, dateMet: contacts.dateMet, createdAt: contacts.createdAt,
      nextFollowUpAt: contacts.nextFollowUpAt,
      sqlEffective: effectiveCadenceSql(), sqlDueAt: cadenceDueAtSql(), sqlDue: followUpDueSql(sql`${now.toISOString()}::timestamptz`),
    }).from(contacts).where(and(eq(contacts.userId, USER), inArray(contacts.id, ids)));
    for (const r of rows) {
      const tsDueAt = cadenceDueAt(r);
      const sqlDueAt = r.sqlDueAt ? new Date(r.sqlDueAt) : null;
      check(`${r.fullName}: effective`, Number(r.sqlEffective ?? -1) === (effectiveCadenceDays(r) ?? -1));
      check(`${r.fullName}: due-at`, (sqlDueAt?.getTime() ?? null) === (tsDueAt?.getTime() ?? null));
      check(`${r.fullName}: due`, Boolean(r.sqlDue) === isFollowUpDue(r, now));
    }
    const dueNames = rows.filter((r) => isFollowUpDue(r, now)).map((r) => r.fullName).sort();
    check("due set", JSON.stringify(dueNames) === JSON.stringify(["Inner default lapsed", "Inner evidenced lapsed", "No touch, date met", "Own 14 null evidence", "Own 30 lapsed", "Scheduled due", "Zero cadence inner default"]));
  } finally {
    if (ids.length) await db.delete(contacts).where(inArray(contacts.id, ids));
  }
  if (failures) { console.error(`\n${failures} cadence check(s) failed`); process.exit(1); }
  console.log("\nall cadence checks passed");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
