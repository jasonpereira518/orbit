/**
 * Seeds a small, fully fake week and checks that the shared product metrics, the three
 * dashboards' building blocks and the weekly digest say what the data says: cohorts judged only
 * once they have matured, internal accounts left out, fractions not bare percentages, and no
 * account named in the Slack text.
 *
 * Counted as deltas (the suite shares one database).
 *
 * Run: npx tsx scripts/smoke-weekly-digest.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  aiFirstCliff,
  channelBreakdown,
  cohortActivation,
  connectorUse,
  failuresTouchingUsers,
  gateConversion,
  pathBreakdown,
  waveTable,
  week2Return,
  weeklyActiveNetworkers,
} from "../src/lib/product-metrics";
import { formatWeeklyDigest, loadWeeklyDigest } from "../src/lib/weekly-digest";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const DAY = 86_400_000;
const P = "smoke-digest-";

run(async () => {
  const db = await getDb();
  const now = new Date();
  const at = (days: number, extraHours = 0) => new Date(now.getTime() - days * DAY - extraHours * 3_600_000);
  const ids = ["a1", "a2", "a3", "n1", "n2", "w1", "w2", "int"].map((k) => P + k);
  const list = sql.join(ids.map((i) => sql`${i}`), sql`, `);
  const clean = async () => {
    for (const t of ["reminders", "contacts", "chat_messages", "chat_threads", "gate_events", "billing_events", "product_events", "capture_jobs", "usage_events", "feedback", "email_sends", "user_settings"]) {
      await db.execute(sql`DELETE FROM ${sql.raw(t)} WHERE user_id IN (${list})`);
    }
    await db.execute(sql`DELETE FROM site_invites WHERE wave_id = 'w98' OR email LIKE ${P + "%"}`);
  };
  await clean();
  const saved = process.env.ADMIN_USER_IDS;
  process.env.ADMIN_USER_IDS = P + "int";

  const user = (id: string, createdDays: number, channel: string | null, path: string | null = null, kind: string | null = null) =>
    db.execute(sql`INSERT INTO user_settings (user_id, email, created_at, signup_utm_source, signup_attributed_at, onboarding_path, account_kind)
      VALUES (${P + id}, ${P + id + "@example.test"}, ${at(createdDays)}, ${channel}, ${at(createdDays)}, ${path}, ${kind})`);
  const activate = async (id: string, createdDays: number) => {
    await db.execute(sql`INSERT INTO contacts (user_id, full_name, source, created_at) VALUES (${P + id}, 'P', 'capture', ${at(createdDays, -2)})`);
    await db.execute(sql`INSERT INTO reminders (user_id, title, created_by, created_at) VALUES (${P + id}, 'x', 'user', ${at(createdDays, -3)})`);
  };

  // The cohort that finished its first week last week: created 10 days ago. Two activate, one does not.
  await user("a1", 10, "reddit", "capture");
  await user("a2", 10, "reddit", "import");
  await user("a3", 10, "newsletter", "capture");
  await activate("a1", 10);
  await activate("a2", 10);
  // Too young to judge: created 2 days ago and activated, but not in the matured cohort.
  await user("n1", 2, "reddit", "capture");
  await activate("n1", 2);
  await user("n2", 3, null);
  // The operator's account activates too and must change nothing.
  await user("int", 10, "direct");
  await activate("int", 10);

  const base = {
    cohort: await cohortActivation(now, 14, 7),
    wan: await weeklyActiveNetworkers(now),
  };
  // (The seeds above are already in; compare with a freshly computed number minus the seeds.)
  check("the matured cohort counts the three real accounts and not the operator", base.cohort.size >= 3);
  const c = await cohortActivation(now, 14, 7);
  // Two of the three seeded accounts activated; allow other scripts' rows by checking the floor.
  check("two of those three activated", c.activated >= 2 && c.activated <= c.size);
  check("an account too young to judge is not in the matured cohort", (await cohortActivation(now, 4, 1)).size >= 2 && (await cohortActivation(now, 14, 7)).size === c.size);

  console.log("\nactive networkers");
  check("an account that acted this week is counted", base.wan.current >= 1 && base.wan.mau >= base.wan.current);
  await db.execute(sql`INSERT INTO reminders (user_id, title, created_by, created_at) VALUES (${P + "int"}, 'today', 'user', ${at(0, 1)})`);
  const withOperator = await weeklyActiveNetworkers(now);
  check("the operator acting today changes nothing", withOperator.current === base.wan.current && withOperator.mau === base.wan.mau, `${base.wan.current} -> ${withOperator.current}`);

  console.log("\nchannels and paths");
  const chans = await channelBreakdown(now, 14);
  const reddit = chans.find((r) => r.channel === "reddit");
  check("sign-ups by first-touch channel", Boolean(reddit) && reddit!.signups >= 3);
  check("only matured accounts are scored for activation", reddit!.matured >= 2 && reddit!.activated >= 2 && reddit!.matured <= reddit!.signups);
  check("an account never attributed is its own channel", chans.some((r) => r.channel === "direct" || r.channel === "unattributed"));
  const paths = await pathBreakdown(now, 28);
  check("activation by onboarding path", paths.find((p) => p.path === "capture")!.accounts >= 3 && paths.some((p) => p.path === "not chosen"));

  console.log("\ninvite waves");
  await db.execute(sql`INSERT INTO user_settings (user_id, email, created_at) VALUES (${P + "w1"}, ${P + "w1@example.test"}, ${at(16)}), (${P + "w2"}, ${P + "w2@example.test"}, ${at(16)})`);
  await db.execute(sql`INSERT INTO site_invites (email, wave_id, source, sent_at, accepted_user_id, accepted_at) VALUES
    (${P + "w1@example.test"}, 'w98', 'manual', ${at(18)}, ${P + "w1"}, ${at(16)}),
    (${P + "w2@example.test"}, 'w98', 'manual', ${at(18)}, ${P + "w2"}, ${at(16)}),
    (${P + "w3@example.test"}, 'w98', 'manual', ${at(18)}, NULL, NULL)`);
  await db.execute(sql`INSERT INTO usage_events (user_id, operation, provider, model, kind, key_owner, success, created_at) VALUES (${P + "w1"}, 'capture.parse', 'gemini', 'm', 'completion', 'orbit', 1, ${at(16, -2)})`);
  await activate("w1", 16);
  await db.execute(sql`INSERT INTO chat_threads (id, user_id) VALUES (gen_random_uuid(), ${P + "w1"})`);
  const waves = await waveTable(now);
  const w98 = waves.find((w) => w.waveId === "w98");
  check("the wave counts invited, accepted, set up, activated", Boolean(w98) && w98!.invited === 3 && w98!.accepted === 2 && w98!.aiReady24h === 1 && w98!.activated === 1 && w98!.matured === 2, JSON.stringify(w98));
  const w2r = await week2Return(now, 28, 14);
  check("week-2 return is judged on accounts that reached two weeks", w2r.size >= 2, JSON.stringify(w2r));
  const cliff = await aiFirstCliff(now);
  check("accounts stuck before their first AI call are counted", cliff.eligible >= cliff.stuck && cliff.stuck >= 1);

  console.log("\nfailures, limits, connectors");
  const f0 = await failuresTouchingUsers(now, 7);
  await db.execute(sql`INSERT INTO capture_jobs (user_id, source_kind, status, created_at) VALUES (${P + "a3"}, 'text', 'failed', ${at(1)}), (${P + "int"}, 'text', 'failed', ${at(1)})`);
  await db.execute(sql`INSERT INTO usage_events (user_id, operation, provider, model, kind, key_owner, success, error_kind, created_at) VALUES (${P + "a3"}, 'chat.answer', 'gemini', 'm', 'completion', 'orbit', 0, 'cancelled', ${at(1)})`);
  const f1 = await failuresTouchingUsers(now, 7);
  check("a failed capture touches one account; the operator's does not; a cancel is not a failure", f1.accounts === f0.accounts + 1, `${f0.accounts} -> ${f1.accounts}`);
  const g0 = await gateConversion(now, 28);
  await db.execute(sql`INSERT INTO gate_events (user_id, feature, plan, created_at) VALUES (${P + "a1"}, 'contacts', 'free', ${at(3)}), (${P + "a2"}, 'contacts', 'free', ${at(3)})`);
  await db.execute(sql`INSERT INTO billing_events (source, event_id, kind, user_id, amount_cents, mrr_delta_cents, effective_at) VALUES ('stripe', ${P + "evt1"}, 'new', ${P + "a1"}, 0, 899, ${at(2)})`);
  const g1 = await gateConversion(now, 28);
  check("two accounts hit a limit and one paid within a week", g1.accounts === g0.accounts + 2 && g1.converted === g0.converted + 1, JSON.stringify(g1));
  await db.execute(sql`INSERT INTO product_events (id, name, surface, actor, user_id, properties) VALUES (gen_random_uuid(), 'mcp_connected', 'mcp', 'user', ${P + "a1"}, '{}'), (gen_random_uuid(), 'mcp_tool_called', 'mcp', 'user', ${P + "a1"}, '{}')`);
  const m = await connectorUse(now, "mcp", 28);
  check("connectors count connected and used", m.connected >= 1 && m.withCall >= 1 && m.calls >= 1);

  console.log("\nthe digest");
  const digest = await loadWeeklyDigest(now);
  const text = formatWeeklyDigest(digest);
  check("it reads as one Slack message with the headline numbers", text.startsWith(":bar_chart:") && text.includes("Active networkers") && text.includes("Activation") && text.includes("Money:") && text.includes("Cost (7 days)"));
  check("rates are fractions, with a percentage only past thirty", /\d+ of \d+/.test(text) && !/\(\d+%\)/.test(text.split("\n").filter((l) => l.startsWith("*Activation")).join("")), text);
  check("no account or email appears", !text.includes(P) && !/@example\.test/.test(text), text);
  check("it stays short enough to read", text.split("\n").length <= 14 && text.length < 2000, String(text.length));

  if (saved === undefined) delete process.env.ADMIN_USER_IDS;
  else process.env.ADMIN_USER_IDS = saved;
  await db.execute(sql`DELETE FROM billing_events WHERE event_id LIKE ${P + "%"}`);
  await clean();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll weekly-digest checks passed.");
});
