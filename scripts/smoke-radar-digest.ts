/**
 * Radar's Monday email: the window, the week claim, the message, and the off switch.
 *
 * On a throwaway PGlite, with delivery replaced by a recorder, so nothing is sent. Checks:
 *   - the clock: ISO weeks at year edges, and each zone's Monday 06:00–09:00 (Auckland's is
 *     Sunday evening in UTC, which is why the cron runs Sundays too);
 *   - who gets one: only the email on, not paused, active this month, holding a card for
 *     today or soon, and only in their own window;
 *   - at most once a week: a second run is a no-op, the claim has one winner, and a send
 *     Resend refused releases its claim so the next hour retries;
 *   - the message: names stay out of the subject, every string is escaped, every link is
 *     the app's own, and the drafts count is there;
 *   - the off switch: a signed token turns it off, a forged or never-issued one does not,
 *     and the link's GET changes nothing (mail scanners fetch every link);
 *   - the timezone capture refuses a zone this runtime does not know;
 *   - the route stands down while Radar is coming soon, and once released stops short of
 *     claiming anyone while Resend is not configured.
 *
 * The clock is fixed years ahead so accounts other scripts leave in the shared database are
 * never "active this month" here. Leaves nothing behind.
 *
 * Run: npx tsx scripts/smoke-radar-digest.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { and, eq, gte, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb } from "../src/db";
import { contacts, cronRuns, recommendations, userSettings } from "../src/db/schema";
import { buildRadarDigestEmail, radarDigestSubject } from "../src/lib/radar/digest-email";
import {
  captureRadarTimeZone,
  claimRadarDigestWeek,
  hashRadarDigestToken,
  inDigestWindow,
  isoWeekOf,
  localClock,
  openDigestZones,
  radarDigestUnsubscribeToken,
  readRadarDigestUnsubscribeToken,
  sendRadarDigests,
  unsubscribeRadarDigest,
  type DigestMessage,
} from "../src/lib/radar/digest";
import { COMING_SOON_KEYS } from "../src/lib/surfaces";
import { ensureUserSettings } from "../src/lib/user-settings";

const PREFIX = "smoke-radar-digest-";
const U = {
  utc: `${PREFIX}utc`,
  auckland: `${PREFIX}auckland`,
  off: `${PREFIX}off`,
  idle: `${PREFIX}idle`,
  later: `${PREFIX}later`,
  paused: `${PREFIX}paused`,
  flaky: `${PREFIX}flaky`,
};
const USERS = Object.values(U);
/** Monday 3 March 2031, ISO week 10. */
const MONDAY_7_UTC = new Date("2031-03-03T07:00:00Z");
const WEEK = "2031-W10";
const DAY = 86_400_000;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function reset() {
  const db = await getDb();
  // Contacts cascade to recommendations.
  await db.delete(contacts).where(inArray(contacts.userId, USERS));
  await db.delete(userSettings).where(inArray(userSettings.userId, USERS));
}

async function account(
  userId: string,
  opts: { tz?: string | null; enabled?: boolean; paused?: boolean; activeDaysAgo?: number; email?: string } = {}
) {
  const db = await getDb();
  await ensureUserSettings(userId);
  await db
    .update(userSettings)
    .set({
      email: opts.email ?? `${userId}@example.com`,
      radarDigestTz: opts.tz ?? null,
      radarDigestEnabled: opts.enabled === false ? 0 : 1,
      radarPaused: opts.paused ? 1 : 0,
      radarDigestLastWeek: null,
      radarDigestUnsubTokenHash: null,
      lastActiveAt: new Date(MONDAY_7_UTC.getTime() - (opts.activeDaysAgo ?? 1) * DAY),
    })
    .where(eq(userSettings.userId, userId));
}

async function card(
  userId: string,
  name: string,
  seed: Partial<typeof recommendations.$inferInsert> = {}
): Promise<string> {
  const db = await getDb();
  const [contact] = await db.insert(contacts).values({ userId, fullName: name, company: "Acme" }).returning();
  const [row] = await db
    .insert(recommendations)
    .values({
      userId,
      contactId: contact!.id,
      kind: "reconnect",
      score: 40,
      bucket: "today",
      // Real time, not the smoke's clock: the query compares against the database's now().
      expiresAt: new Date(Date.now() + 30 * DAY),
      inputsHash: "h1",
      reasons: [{ code: "dormant", label: "Quiet for 7 months", points: 30 }],
      ...seed,
    })
    .returning();
  return row!.id;
}

async function main() {
  await reset();
  const db = await getDb();

  console.log("the clock");
  check("ISO week of a mid-year Monday", isoWeekOf("2026-09-28") === "2026-W40", isoWeekOf("2026-09-28"));
  check("1 Jan 2027 belongs to 2026's last week", isoWeekOf("2027-01-01") === "2026-W53", isoWeekOf("2027-01-01"));
  check("4 Jan 2021 is week 1", isoWeekOf("2021-01-04") === "2021-W01", isoWeekOf("2021-01-04"));
  check("29 Dec 2025 is 2026's week 1", isoWeekOf("2025-12-29") === "2026-W01", isoWeekOf("2025-12-29"));
  check("the smoke's Monday is week 10", isoWeekOf(localClock(MONDAY_7_UTC, "UTC").ymd) === WEEK);
  const sundayEveningUtc = new Date("2031-03-02T18:00:00Z");
  check("Auckland's Monday 07:00 is Sunday evening in UTC", inDigestWindow(sundayEveningUtc, "Pacific/Auckland"));
  check("…and not in UTC's window", !inDigestWindow(sundayEveningUtc, "UTC"));
  check("UTC's Monday 07:00 is in UTC's window", inDigestWindow(MONDAY_7_UTC, "UTC"));
  check("…but Monday 20:00 in Auckland is not", !inDigestWindow(MONDAY_7_UTC, "Pacific/Auckland"));
  check("Los Angeles opens at Monday 15:00 UTC", inDigestWindow(new Date("2031-03-03T15:30:00Z"), "America/Los_Angeles"));
  check("09:00 local is already closed", !inDigestWindow(new Date("2031-03-03T09:00:00Z"), "UTC"));
  const open = openDigestZones(sundayEveningUtc, ["UTC", "Pacific/Auckland", "America/Los_Angeles", "Not/AZone"]);
  check(
    "open zones on Sunday evening UTC: Auckland alone, in Monday's week",
    open.size === 1 && JSON.stringify(open.get(WEEK)) === JSON.stringify(["Pacific/Auckland"]),
    JSON.stringify([...open])
  );

  console.log("\nthe unsubscribe token");
  {
    const token = radarDigestUnsubscribeToken(U.utc);
    check("a token names its account", readRadarDigestUnsubscribeToken(token) === U.utc);
    const [id, mac] = token.split(".");
    const forged = `${Buffer.from(U.off).toString("base64url")}.${mac}`;
    check("another account's id under this MAC is refused", readRadarDigestUnsubscribeToken(forged) === null);
    check("a tampered MAC is refused", readRadarDigestUnsubscribeToken(`${id}.${mac!.slice(1)}x`) === null);
    check("junk is refused", readRadarDigestUnsubscribeToken("nope") === null && readRadarDigestUnsubscribeToken(null) === null);
    check("the token is the same every week", radarDigestUnsubscribeToken(U.utc) === token);
  }

  console.log("\nthe message");
  {
    const content = {
      total: 7,
      drafts: 2,
      people: [
        { id: "rec<1>", name: "Ada <script>alert(1)</script>", kind: "reconnect" as const, company: "Acme & Co", line: "Quiet for 7 months", hasDraft: true },
        { id: "rec2", name: "Grace", kind: "heads_up" as const, company: null, line: "x".repeat(400), hasDraft: false },
      ],
    };
    const email = buildRadarDigestEmail(content, {
      appUrl: "https://app.example",
      unsubscribeUrl: "https://app.example/api/radar/digest/unsubscribe?token=t",
    });
    check("the subject counts, and names nobody", email.subject === "2 drafts ready · 7 people worth a message this week", email.subject);
    check("a subject without drafts", radarDigestSubject({ total: 1, drafts: 0 }) === "1 person worth a message this week");
    check("names are escaped", !email.html.includes("<script>") && email.html.includes("&lt;script&gt;"));
    check("companies are escaped", email.html.includes("Acme &amp; Co"));
    const hrefs = [...email.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
    check("every link is the app's own", hrefs.length > 0 && hrefs.every((h) => h.startsWith("https://app.example/")), hrefs.join(" "));
    check("each person links to their card", email.html.includes("/radar?focus=rec%3C1%3E"));
    check("a long line is clipped", !email.html.includes("x".repeat(200)));
    check("the text part carries the off switch", email.text.includes("Turn it off: https://app.example/api/radar/digest/unsubscribe?token=t"));
    check("and says how many others", email.text.includes("And 5 others"));
  }

  console.log("\nwho gets one, and when");
  await account(U.utc, { tz: null });
  await account(U.auckland, { tz: "Pacific/Auckland" });
  await account(U.off, { tz: "UTC", enabled: false });
  await account(U.idle, { tz: "UTC", activeDaysAgo: 40 });
  await account(U.later, { tz: "UTC" });
  await account(U.paused, { tz: "UTC", paused: true });
  await account(U.flaky, { tz: "UTC", enabled: false });
  const utcCard = await card(U.utc, "Ada Lovelace", {
    aiNote: { why: "She asked about your launch", opener: "o", inputsHash: "h1", generatedAt: "2031-03-01T00:00:00Z" },
    draft: { body: "Hi Ada", channel: "email", inputsHash: "h1", generatedAt: "2031-03-01T00:00:00Z" },
  });
  await card(U.utc, "Grace Hopper", { bucket: "soon", score: 30, aiNote: { why: "stale note", opener: "o", inputsHash: "old", generatedAt: "x" } });
  await card(U.utc, "Snoozed Sam", { status: "snoozed" });
  await card(U.auckland, "Kiri");
  await card(U.off, "Off Olly");
  await card(U.idle, "Idle Ida");
  await card(U.later, "Later Lee", { bucket: "later" });
  await card(U.paused, "Paused Pat");

  const sent: DigestMessage[] = [];
  const deliver = async (m: DigestMessage) => {
    sent.push(m);
    return { ok: true };
  };
  // Recorded here, not in error_events: a real `resend.rejected` row would open an alert in
  // any ops smoke sharing this database.
  const reported: Array<{ userId: string; error: string }> = [];
  const report = async (f: { userId: string; error: string }) => {
    reported.push(f);
  };
  const first = await sendRadarDigests(MONDAY_7_UTC, { deliver, report, gapMs: 0 });
  const mine = sent.filter((m) => m.to.startsWith(PREFIX));
  check("Monday 07:00 UTC: only the UTC account with the email on, active, and a card today", mine.length === 1 && mine[0]!.to === `${U.utc}@example.com`, mine.map((m) => m.to).join(","));
  check("the run's stats agree", first.sent >= 1 && first.failed === 0, JSON.stringify(first));
  const msg = mine[0]!;
  check("its subject counts the draft and both live cards", msg.subject === "1 draft ready · 2 people worth a message this week", msg.subject);
  check("today's card comes first, with the AI note's line", msg.text.indexOf("Ada Lovelace") < msg.text.indexOf("Grace Hopper") && msg.text.includes("She asked about your launch"));
  check("a stale AI note is not used; the lead reason is", !msg.text.includes("stale note") && msg.text.includes("Quiet for 7 months"));
  check("a snoozed card is left out", !msg.text.includes("Snoozed Sam"));
  check("its card link is there", msg.text.includes(`/radar?focus=${utcCard}`));
  const [claimed] = await db.select().from(userSettings).where(eq(userSettings.userId, U.utc));
  check("the week is stamped", claimed?.radarDigestLastWeek === WEEK, String(claimed?.radarDigestLastWeek));
  check("the token's hash is recorded", claimed?.radarDigestUnsubTokenHash === hashRadarDigestToken(radarDigestUnsubscribeToken(U.utc)));

  sent.length = 0;
  await sendRadarDigests(new Date(MONDAY_7_UTC.getTime() + 3_600_000), { deliver, report, gapMs: 0 });
  check("the next hour's run sends nobody a second one", sent.filter((m) => m.to.startsWith(PREFIX)).length === 0);

  sent.length = 0;
  await sendRadarDigests(new Date("2031-03-02T18:00:00Z"), { deliver, report, gapMs: 0 });
  const nz = sent.filter((m) => m.to.startsWith(PREFIX));
  check("Sunday 18:00 UTC: Auckland's Monday morning, Auckland alone", nz.length === 1 && nz[0]!.to === `${U.auckland}@example.com`, nz.map((m) => m.to).join(","));

  console.log("\nthe claim");
  {
    const token = hashRadarDigestToken(radarDigestUnsubscribeToken(U.utc));
    const both = await Promise.all([
      claimRadarDigestWeek(U.utc, "2031-W11", token),
      claimRadarDigestWeek(U.utc, "2031-W11", token),
    ]);
    check("two claims for the same week: exactly one wins", both.filter(Boolean).length === 1, JSON.stringify(both));
    check("the winner learns the week it replaced", both.find(Boolean)?.prev === WEEK);
    check("a turned-off account can't be claimed", (await claimRadarDigestWeek(U.off, "2031-W11", token)) === undefined);
    await db.update(userSettings).set({ radarDigestLastWeek: WEEK }).where(eq(userSettings.userId, U.utc));
  }

  console.log("\na refused send");
  {
    await card(U.flaky, "Flaky Flo");
    await db
      .update(userSettings)
      .set({ radarDigestEnabled: 1, radarDigestLastWeek: "2031-W09" })
      .where(eq(userSettings.userId, U.flaky));
    const refused = await sendRadarDigests(MONDAY_7_UTC, {
      deliver: async (m) => (m.to.startsWith(PREFIX) ? { ok: false, error: "rate limited" } : { ok: true }),
      report,
      gapMs: 0,
    });
    const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, U.flaky));
    check("Resend refusing marks it failed", refused.failed >= 1, JSON.stringify(refused));
    check("and puts back the week it replaced, so the next hour retries", row?.radarDigestLastWeek === "2031-W09", String(row?.radarDigestLastWeek));
    check("Resend's reason is recorded, once", reported.length === 1 && reported[0]!.error === "rate limited", JSON.stringify(reported));
    sent.length = 0;
    await sendRadarDigests(new Date(MONDAY_7_UTC.getTime() + 3_600_000), { deliver, report, gapMs: 0 });
    check("the next hour sends it", sent.some((m) => m.to === `${U.flaky}@example.com`));
  }

  console.log("\nthe budget");
  {
    await db.update(userSettings).set({ radarDigestLastWeek: null }).where(eq(userSettings.userId, U.flaky));
    sent.length = 0;
    const out = await sendRadarDigests(MONDAY_7_UTC, { deliver, report, gapMs: 0, budgetMs: 0 });
    check("no time left: nothing claimed, and the run says so", out.budgetExhausted && out.claimed === 0 && sent.length === 0, JSON.stringify(out));
  }

  console.log("\nthe off switch");
  {
    const { GET, POST } = await import("../src/app/api/radar/digest/unsubscribe/route");
    const token = radarDigestUnsubscribeToken(U.utc);
    const url = `https://app.example/api/radar/digest/unsubscribe?token=${encodeURIComponent(token)}`;
    const get = await GET(new NextRequest(url));
    let [row] = await db.select().from(userSettings).where(eq(userSettings.userId, U.utc));
    check("GET asks, and changes nothing", get.status === 200 && (await get.text()).includes('method="post"') && row?.radarDigestEnabled === 1);
    const post = await POST(new NextRequest(url, { method: "POST" }));
    [row] = await db.select().from(userSettings).where(eq(userSettings.userId, U.utc));
    check("POST turns it off", post.status === 200 && row?.radarDigestEnabled === 0, `${post.status} ${row?.radarDigestEnabled}`);
    check("a second click is still fine", await unsubscribeRadarDigest(token));
    check("a token for an account never sent one does nothing", !(await unsubscribeRadarDigest(radarDigestUnsubscribeToken(U.later))));
    const forged = await POST(new NextRequest(`https://app.example/api/radar/digest/unsubscribe?token=${U.later}.abc`, { method: "POST" }));
    check("a forged token is a 404", forged.status === 404);
    const missing = await POST(new NextRequest("https://app.example/api/radar/digest/unsubscribe", { method: "POST" }));
    check("no token is a 400", missing.status === 400);
    sent.length = 0;
    await db.update(userSettings).set({ radarDigestLastWeek: null }).where(eq(userSettings.userId, U.utc));
    await sendRadarDigests(MONDAY_7_UTC, { deliver, report, gapMs: 0 });
    check("once off, no email even with the week unclaimed", !sent.some((m) => m.to === `${U.utc}@example.com`));
  }

  console.log("\nthe timezone capture");
  {
    await captureRadarTimeZone(U.later, "Mars/Olympus_Mons");
    let [row] = await db.select().from(userSettings).where(eq(userSettings.userId, U.later));
    check("an unknown zone is refused", row?.radarDigestTz === "UTC", String(row?.radarDigestTz));
    await captureRadarTimeZone(U.later, "'; DROP TABLE users; --");
    [row] = await db.select().from(userSettings).where(eq(userSettings.userId, U.later));
    check("so is anything that isn't a zone", row?.radarDigestTz === "UTC");
    await captureRadarTimeZone(U.later, "America/New_York");
    [row] = await db.select().from(userSettings).where(eq(userSettings.userId, U.later));
    check("a real zone is kept", row?.radarDigestTz === "America/New_York");
  }

  console.log("\nthe route");
  {
    const started = new Date();
    process.env.CRON_SECRET = "smoke-radar-digest-secret";
    const { POST } = await import("../src/app/api/radar/digest/route");
    const res = await POST(
      new Request("https://app.example/api/radar/digest", {
        method: "POST",
        headers: { Authorization: "Bearer smoke-radar-digest-secret" },
      })
    );
    const body = (await res.json()) as { standDown?: boolean; notConfigured?: boolean };
    if (COMING_SOON_KEYS.has("page.radar")) {
      check("while Radar is coming soon, the route sends nobody anything", res.status === 200 && body.standDown === true, JSON.stringify(body));
    } else {
      // Released: the gate lets the run through, and with no Resend key (smoke/_env removes
      // it) it stops before claiming anyone's week, so no week is spent on an unsendable email.
      check("once released, the route gets past the gate", res.status === 200 && body.standDown !== true, JSON.stringify(body));
      check("and without Resend it claims nobody's week", body.notConfigured === true, JSON.stringify(body));
    }
    await db.delete(cronRuns).where(and(eq(cronRuns.job, "radar.digest"), gte(cronRuns.startedAt, started)));
    delete process.env.CRON_SECRET;
  }

  await reset();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll Radar digest checks passed.");
}

run(main);
