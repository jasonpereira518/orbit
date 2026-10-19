/**
 * Guards the two shared definitions behind every retention and activation number:
 * `intentionalActionsSince` ("active") and `activatedSql` ("activated"), plus the rule that
 * internal and tester accounts and a non-UTC database session cannot move a chart.
 *
 * Each case is a failure that previously showed up on the Growth page as a plausible number:
 * a calendar sync or a nightly Radar call making a dormant account a DAU, the operator's own
 * account in the active count, a tour-only account scored as activated.
 *
 * Counted as deltas: the suite shares one PGlite database.
 *
 * Run: npx tsx scripts/smoke-activity-definitions.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { activatedSql } from "../src/lib/activity";
import { growthSnapshot, userTotalsTrend, activationTrend, rollingActiveTrend } from "../src/lib/admin-trends";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const P = "smoke-act-";

run(async () => {
  const db = await getDb();
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms);
  const savedAdmins = process.env.ADMIN_USER_IDS;

  const users = ["dormant-sync", "dormant-ai", "hand", "admin", "kind-internal", "kind-tester", "tour", "activated", "contact-only", "two-captures"].map((k) => P + k);
  const clean = async () => {
    for (const t of ["capture_jobs", "interactions", "contacts", "reminders", "chat_messages", "product_events", "usage_events", "user_settings", "chat_threads"]) {
      await db.execute(sql`DELETE FROM ${sql.raw(t)} WHERE user_id IN (${sql.join(users.map((u) => sql`${u}`), sql`, `)})`);
    }
  };
  await clean();
  process.env.ADMIN_USER_IDS = P + "admin";

  const base0 = await growthSnapshot(7);
  const signup = (id: string, age: number, kind: string | null = null) =>
    db.execute(sql`INSERT INTO user_settings (user_id, email, created_at, account_kind) VALUES (${P + id}, ${`${P}${id}@example.test`}, ${ago(age)}, ${kind})`);
  await signup("dormant-sync", 40 * DAY);
  await signup("dormant-ai", 40 * DAY);
  await signup("hand", 40 * DAY);
  await signup("admin", 40 * DAY);
  await signup("kind-internal", 40 * DAY, "internal");
  await signup("kind-tester", 40 * DAY, "tester");

  const contactRow = async (id: string, source: string | null = null, at = ago(2 * HOUR)) => {
    const r = await db.execute(sql`INSERT INTO contacts (user_id, full_name, source, created_at) VALUES (${P + id}, 'P', ${source}, ${at}) RETURNING id`);
    return rowsOf<{ id: string }>(r)[0]!.id;
  };

  console.log("what counts as active");
  const before = await growthSnapshot(7);
  // A calendar sync writes an interaction with an external id; nobody did anything.
  const c1 = await contactRow("dormant-sync", "calendar_import", ago(40 * DAY));
  await db.execute(sql`INSERT INTO interactions (user_id, contact_id, external_id, created_at) VALUES (${P + "dormant-sync"}, ${c1}, 'cal-1', ${ago(HOUR)})`);
  // The nightly Radar pass writes a usage row for an account that did nothing.
  await db.execute(sql`INSERT INTO usage_events (user_id, operation, provider, model, kind, key_owner, success, created_at) VALUES (${P + "dormant-ai"}, 'radar.why', 'gemini', 'm', 'completion', 'orbit', 1, ${ago(HOUR)})`);
  const mid = await growthSnapshot(7);
  check("a calendar-synced interaction does not make an account active", mid.dau === before.dau, `${before.dau} -> ${mid.dau}`);
  check("a background AI call does not either", mid.wau === before.wau, `${before.wau} -> ${mid.wau}`);

  // The operator, an account marked internal and one marked tester each really do things.
  for (const who of ["admin", "kind-internal", "kind-tester"]) {
    const c = await contactRow(who, null, ago(HOUR));
    await db.execute(sql`INSERT INTO interactions (user_id, contact_id, created_at) VALUES (${P + who}, ${c}, ${ago(HOUR)})`);
    await db.execute(sql`INSERT INTO capture_jobs (user_id, source_kind, status, created_at) VALUES (${P + who}, 'text', 'saved', ${ago(HOUR)})`);
  }
  const excl = await growthSnapshot(7);
  check("admin, internal and tester accounts are not in the active count", excl.dau === mid.dau && excl.wau === mid.wau && excl.mau === mid.mau, `${mid.dau}/${mid.wau} -> ${excl.dau}/${excl.wau}`);
  check("nor in the account total", excl.total === base0.total + 3, `total ${base0.total} -> ${excl.total} (six signups, three of them internal)`);

  // A person captures: that counts.
  const c3 = await contactRow("hand", null, ago(HOUR));
  await db.execute(sql`INSERT INTO interactions (user_id, contact_id, created_at) VALUES (${P + "hand"}, ${c3}, ${ago(HOUR)})`);
  const after = await growthSnapshot(7);
  check("a hand-logged note makes an account active", after.dau === excl.dau + 1 && after.wau === excl.wau + 1, `${excl.dau} -> ${after.dau}`);
  // An MCP tool call is an action with no table of its own.
  await db.execute(sql`INSERT INTO product_events (id, name, surface, actor, user_id, properties) VALUES (gen_random_uuid(), 'mcp_tool_called', 'mcp', 'user', ${P + "dormant-ai"}, '{}')`);
  const viaMcp = await growthSnapshot(7);
  check("an MCP tool call by a person counts", viaMcp.dau === after.dau + 1);
  await db.execute(sql`INSERT INTO product_events (id, name, surface, actor, user_id, properties) VALUES (gen_random_uuid(), 'mcp_tool_called', 'cron', 'system', ${P + "dormant-sync"}, '{}')`);
  const sys = await growthSnapshot(7);
  check("the same event written by the system does not", sys.dau === viaMcp.dau);

  console.log("\nwhat counts as activated");
  const check7 = async (id: string) => {
    const r = await db.execute(sql`SELECT ${activatedSql(sql`s.user_id`, sql`s.created_at`)} AS a FROM user_settings s WHERE s.user_id = ${P + id}`);
    return Boolean(rowsOf<{ a: boolean }>(r)[0]?.a);
  };
  await signup("tour", 10 * DAY);
  for (let i = 0; i < 8; i++) await contactRow("tour", "tour-example", ago(10 * DAY - HOUR));
  const th = rowsOf<{ id: string }>(await db.execute(sql`INSERT INTO chat_threads (user_id) VALUES (${P + "tour"}) RETURNING id`))[0]!.id;
  await db.execute(sql`INSERT INTO chat_messages (thread_id, user_id, role, content, created_at) VALUES (${th}, ${P + "tour"}, 'user', 'hi', ${ago(10 * DAY - 2 * HOUR)})`);
  check("tour examples plus a chat question is not activated", !(await check7("tour")));

  await signup("contact-only", 10 * DAY);
  await contactRow("contact-only", null, ago(10 * DAY - HOUR));
  check("a contact and nothing more is not activated", !(await check7("contact-only")));

  await signup("activated", 10 * DAY);
  await contactRow("activated", "capture", ago(10 * DAY - HOUR));
  await db.execute(sql`INSERT INTO reminders (user_id, title, created_by, created_at) VALUES (${P + "activated"}, 'x', 'user', ${ago(10 * DAY - 2 * HOUR)})`);
  check("an own contact and a follow-up the person set is activated", await check7("activated"));

  await signup("two-captures", 10 * DAY);
  await contactRow("two-captures", "capture", ago(10 * DAY - HOUR));
  await db.execute(sql`INSERT INTO capture_jobs (user_id, source_kind, status, created_at) VALUES (${P + "two-captures"}, 'text', 'saved', ${ago(10 * DAY - HOUR)}), (${P + "two-captures"}, 'text', 'saved', ${ago(9 * DAY)})`);
  check("captures on two different days is activated", await check7("two-captures"));

  // The same follow-up created by a calendar sync is not a person acting.
  await db.execute(sql`UPDATE reminders SET created_by = 'calendar_sync' WHERE user_id = ${P + "activated"}`);
  check("a follow-up the system created does not activate", !(await check7("activated")));
  // And one set after the window closes is too late.
  await db.execute(sql`UPDATE reminders SET created_by = 'user', created_at = ${ago(2 * DAY)} WHERE user_id = ${P + "activated"}`);
  check("an act after the seven-day window is too late", !(await check7("activated")));

  console.log("\nbuckets do not depend on the database session's time zone");
  const snapshot = async () => JSON.stringify({
    totals: (await userTotalsTrend("day", 10)).map((p) => [p.bucketStart.toISOString(), p.added, p.total]),
    act: (await activationTrend("day", 10)).map((p) => [p.bucketStart.toISOString(), p.signed, p.activated]),
    roll: (await rollingActiveTrend("day", 10)).map((p) => [p.bucketStart.toISOString(), p.dau, p.wau, p.mau]),
  });
  const utc = await snapshot();
  await db.execute(sql`SET TIME ZONE 'America/Los_Angeles'`);
  const la = await snapshot();
  await db.execute(sql`SET TIME ZONE 'Pacific/Auckland'`);
  const nz = await snapshot();
  await db.execute(sql`SET TIME ZONE 'UTC'`);
  check("the same charts under America/Los_Angeles", la === utc);
  check("and under Pacific/Auckland", nz === utc);

  if (savedAdmins === undefined) delete process.env.ADMIN_USER_IDS;
  else process.env.ADMIN_USER_IDS = savedAdmins;
  await clean();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll activity-definition checks passed.");
});
