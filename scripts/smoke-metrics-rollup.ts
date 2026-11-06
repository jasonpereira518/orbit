/**
 * The daily rollup (`src/lib/metrics-rollup.ts`): idempotent, agrees with a direct count of
 * the definitions it reuses, excludes internal accounts, and reads back through `rollupSeries`.
 *
 * Seeds three days in 2020, which nothing else in the suite's shared PGlite writes to.
 *
 * Run: npx tsx scripts/smoke-metrics-rollup.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { metricsDaily, pageViews } from "../src/db/schema";
import { intentionalActionsSince } from "../src/lib/activity";
import { rollupDays, rollupSeries } from "../src/lib/metrics-rollup";
import { checker } from "./smoke/check";

const P = "user_smokeRollup";
const D1 = "2020-03-02";
const D2 = "2020-03-03";
const D3 = "2020-03-04";
const at = (day: string, hour = 12) => new Date(`${day}T${String(hour).padStart(2, "0")}:00:00.000Z`);

run(async () => {
  const t = checker();
  const db = await getDb();
  const users = ["A", "B", "Internal"].map((k) => P + k);
  const ids = sql.join(users.map((u) => sql`${u}`), sql`, `);
  // The suite shares one PGlite database, so this runs at both ends: left behind, these 2020
  // accounts shift every later smoke that counts users (growth-trends, clerk-orphan-sweep).
  const cleanup = async () => {
    for (const table of ["chat_messages", "chat_threads", "reminders", "usage_events", "outreach_campaigns", "user_settings"]) {
      await db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE user_id IN (${ids})`);
    }
    await db.delete(pageViews).where(eq(pageViews.route, "/__smoke-rollup"));
    await db.delete(metricsDaily).where(inArray(metricsDaily.day, [D1, D2, D3]));
  };
  await cleanup();

  // Accounts: A signs up on D1 from a newsletter, B on D2 from Reddit, Internal on D1 (excluded).
  const signup = (id: string, day: string, kind: string | null, utm: string | null, ref: string | null) =>
    db.execute(sql`INSERT INTO user_settings (user_id, email, created_at, account_kind, signup_utm_source, signup_referrer, signup_attributed_at)
      VALUES (${P + id}, ${`${P}${id}@example.test`}, ${at(day, 9)}, ${kind}, ${utm}, ${ref}, ${at(day, 9)})`);
  await signup("A", D1, null, "newsletter", null);
  await signup("B", D2, null, null, "reddit.com");
  await signup("Internal", D1, "internal", "newsletter", null);

  // Actions: A asks chat on D1 and D2; B sets a follow-up on D2; Internal asks chat on D1.
  const chat = async (id: string, day: string) => {
    const [th] = rowsOf<{ id: string }>(await db.execute(sql`INSERT INTO chat_threads (user_id) VALUES (${P + id}) RETURNING id`));
    await db.execute(sql`INSERT INTO chat_messages (thread_id, user_id, role, content, created_at) VALUES (${th!.id}, ${P + id}, 'user', 'q', ${at(day)})`);
  };
  await chat("A", D1);
  await chat("A", D2);
  await chat("Internal", D1);
  await db.execute(sql`INSERT INTO reminders (user_id, title, created_by, created_at) VALUES (${P + "B"}, 'r', 'user', ${at(D2)})`);

  // Page views: on D1 two human views by one visitor, a bot, an internal view; on D2 one view.
  const view = (day: string, visitor: string, extra: Partial<typeof pageViews.$inferInsert> = {}) =>
    db.insert(pageViews).values({
      id: randomUUID(), visitorHash: visitor, sessionId: randomUUID(), userId: null, route: "/__smoke-rollup",
      referrerHost: null, utmSource: null, utmMedium: null, utmCampaign: null, country: null, region: null, city: null,
      device: "desktop", isBot: false, createdAt: at(day), ...extra,
    });
  await view(D1, "v1");
  await view(D1, "v1");
  await view(D1, "bot", { isBot: true });
  await view(D1, "staff", { isInternal: true });
  await view(D2, "v2");

  // AI cost and outreach on D1/D2.
  await db.execute(sql`INSERT INTO usage_events (user_id, operation, provider, model, kind, key_owner, estimated_cost_micros, created_at)
    VALUES (${P + "A"}, 'chat', 'gemini', 'm', 'text', 'orbit', 1500, ${at(D1)}), (${P + "A"}, 'chat', 'gemini', 'm', 'text', 'orbit', 500, ${at(D1, 13)})`);
  const [camp] = rowsOf<{ id: string }>(await db.execute(sql`INSERT INTO outreach_campaigns (user_id, name) VALUES (${P + "A"}, 'c') RETURNING id`));
  const [pros] = rowsOf<{ id: string }>(await db.execute(sql`INSERT INTO outreach_prospects (campaign_id, external_id, full_name) VALUES (${camp!.id}, ${randomUUID()}, 'P') RETURNING id`));
  await db.execute(sql`INSERT INTO outreach_messages (prospect_id, channel, body, status, sent_at, delivered_at, opened_at)
    VALUES (${pros!.id}, 'email', 'hi', 'sent', ${at(D1)}, ${at(D1, 13)}, ${at(D2)})`);

  const now = at(D3, 1);
  const snapshot = async () =>
    (await db.select().from(metricsDaily).where(inArray(metricsDaily.day, [D1, D2, D3])))
      .map((r) => `${r.day}|${r.metric}|${r.dim}=${r.value}`)
      .sort();

  console.log("rollupDays");
  await rollupDays([at(D1), at(D2), at(D3)], now);
  const first = await snapshot();
  await rollupDays([at(D2), at(D1), at(D3)], now);
  const second = await snapshot();
  t.check("running it twice gives identical rows (idempotent)", JSON.stringify(first) === JSON.stringify(second), `${first.length} vs ${second.length}`);

  const value = async (day: string, metric: string, dim = "") =>
    (await db.select().from(metricsDaily).where(and(eq(metricsDaily.day, day), eq(metricsDaily.metric, metric), eq(metricsDaily.dim, dim))))[0]?.value;

  // Direct counts from the definitions the rollup reuses, for the seeded accounts only.
  const direct = async (day: string) => {
    const e = new Date(at(day, 0).getTime() + 86_400_000).toISOString();
    const [r] = rowsOf<{ n: number }>(await db.execute(sql`
      SELECT count(DISTINCT user_id)::int AS n FROM (${intentionalActionsSince(sql`${e}::timestamptz - interval '1 day'`)}) w
      WHERE created_at < ${e}::timestamptz`));
    return r?.n ?? 0;
  };
  t.check("signups count accounts created that day, internal excluded", (await value(D1, "signups")) === 1 && (await value(D2, "signups")) === 1 && (await value(D3, "signups")) === 0);
  t.check("dau matches a direct count over intentionalActionsSince", (await value(D1, "dau")) === (await direct(D1)) && (await value(D2, "dau")) === (await direct(D2)));
  t.check("dau excludes the internal account (A alone on D1; A and B on D2)", (await value(D1, "dau")) === 1 && (await value(D2, "dau")) === 2);
  t.check("wau / mau are trailing windows (D3: A and B still active in 7 and 30 days, nobody today)", (await value(D3, "dau")) === 0 && (await value(D3, "wau")) === 2 && (await value(D3, "mau")) === 2);
  t.check("page views exclude bots and internal traffic", (await value(D1, "page_views")) === 2 && (await value(D1, "visitor_days")) === 1 && (await value(D2, "page_views")) === 1);
  t.check("signups by first-touch channel", (await value(D1, "signups_channel", "newsletter")) === 1 && (await value(D2, "signups_channel", "reddit.com")) === 1);
  t.check("AI cost by operation and key owner", (await value(D1, "ai_cost_micros", "chat|orbit")) === 2000);
  t.check(
    "outreach email by the day each event fell on",
    (await value(D1, "outreach_emails", "sent")) === 1 && (await value(D1, "outreach_emails", "delivered")) === 1 &&
      (await value(D1, "outreach_emails", "opened")) === 0 && (await value(D2, "outreach_emails", "opened")) === 1
  );
  t.check("MRR is snapshotted only for the day the job runs", (await value(D3, "mrr_cents")) !== undefined && (await value(D1, "mrr_cents")) === undefined);

  // A dimension that vanishes on recompute is removed, not left stale.
  await db.execute(sql`UPDATE user_settings SET signup_utm_source = 'podcast' WHERE user_id = ${P + "A"}`);
  await rollupDays([at(D1)], now);
  t.check("a recompute drops a dimension that no longer has rows", (await value(D1, "signups_channel", "newsletter")) === undefined && (await value(D1, "signups_channel", "podcast")) === 1);
  t.check("…and leaves a past day's MRR snapshot alone", (await value(D3, "mrr_cents")) !== undefined);

  console.log("\nrollupSeries");
  const series = await rollupSeries("dau", { from: at(D1), to: at(D3) }, now);
  t.check("returns past days only, in order", JSON.stringify(series) === JSON.stringify([{ day: D1, value: 1 }, { day: D2, value: 2 }]), JSON.stringify(series));
  const channel = await rollupSeries("signups_channel", { from: at(D1), to: at(D3), dim: "reddit.com" }, now);
  t.check("reads a dimension", JSON.stringify(channel) === JSON.stringify([{ day: D2, value: 1 }]), JSON.stringify(channel));

  await cleanup();
  t.done("metrics rollup");
});
