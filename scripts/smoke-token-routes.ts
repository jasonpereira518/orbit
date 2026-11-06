/**
 * The routes whose ONLY credential is an opaque token in the URL: the calendar feed
 * (`/api/calendar/[token]`) and the phone half of note scanning (`/api/scan/[token]/*`).
 *
 * Both are listed in src/lib/public-routes.ts because their callers — a calendar client, a
 * phone that has never signed in — cannot hold a Clerk session. So `requireUserId()` and its
 * suspension and stealth gates never run on them; whatever the token lookup refuses is all
 * that is refused. The lookups themselves are covered by smoke-calendar-feed-token and
 * smoke-scan-handoff. This drives the real route handlers and pins what those do not:
 *
 *   - the feed's 24-character floor holds even for a token that IS stored (so the floor is a
 *     real pre-check, not an accident of hashing), and a 24-character token is accepted;
 *   - an unknown token → 404; a suspended owner's valid token → 404 with no write (the
 *     last-fetched stamp does not move);
 *   - a valid token → 200 `text/calendar` carrying the owner's reminders and nothing of
 *     another account's — not their reminders, and not the name of their contact even when
 *     the owner's reminder points at it; the ETag round-trips to a 304;
 *   - the scan routes answer 404 for a malformed, unknown, or suspended-owner token without
 *     consuming the grant, and a live token finishes (positive control).
 *
 * PINNED, NOT ENDORSED: both lookups check `suspendedAt` but not `isHeldByStealth`. A held
 * account is never let into the app, so it cannot reach the server actions that mint either
 * token (both go through `requireUserId`); and an account that minted one while admitted is
 * not re-held later, because re-enabling stealth re-dates `stealth_since` past its row. No
 * exploit path was found, so this records the current behaviour rather than a bug — if a
 * stealth check is ever added to the lookups, flip these two checks.
 *
 * Run: npx tsx scripts/smoke-token-routes.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb } from "../src/db";
import { adminAuditLog, captureHandoffs, captureJobs, siteSettings, userSettings } from "../src/db/schema";
import { findUserByFeedToken, hashCalendarFeedToken, mintCalendarFeedToken } from "../src/lib/calendar-feed";
import { findScanHandoff, generateHandoffToken, mintScanHandoff } from "../src/lib/scan-handoff";
import { setStealth } from "../src/lib/site-access";
import { ensureUserSettings } from "../src/lib/user-settings";
import { GET as feedGet } from "../src/app/api/calendar/[token]/route";
import { POST as scanFinish } from "../src/app/api/scan/[token]/finish/route";
import { POST as scanPages } from "../src/app/api/scan/[token]/pages/route";
import { checker } from "./smoke/check";
import { fakeUserId, insertContact, insertReminder, purgeUsers } from "./smoke/factories";

const OWNER = fakeUserId("tok_owner");
const OTHER = fakeUserId("tok_other");
const SHORT = fakeUserId("tok_short");
const HELD = fakeUserId("tok_held");
const ADMIN = fakeUserId("tok_admin");
const ALL = [OWNER, OTHER, SHORT, HELD, ADMIN];

const feed = (token: string, headers: Record<string, string> = {}) =>
  feedGet(new NextRequest(`http://localhost/api/calendar/${token}`, { headers }), { params: Promise.resolve({ token }) });
const finish = (token: string) =>
  scanFinish(new NextRequest(`http://localhost/api/scan/${token}/finish`, { method: "POST" }), { params: Promise.resolve({ token }) });
const pages = (token: string) =>
  scanPages(
    new NextRequest(`http://localhost/api/scan/${token}/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [{ name: "p.jpg", mimeType: "image/jpeg", base64: "AAAA" }] }),
    }),
    { params: Promise.resolve({ token }) }
  );

run(async () => {
  const t = checker();
  const db = await getDb();
  await purgeUsers(db, ALL);
  const siteBefore = await db.query.siteSettings.findFirst({ where: eq(siteSettings.id, 1) });
  const settingsOf = (userId: string) => db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });

  try {
    // --- Calendar feed: the lookup ----------------------------------------------------------
    console.log("findUserByFeedToken…");
    await ensureUserSettings(SHORT);
    for (const [len, expect] of [
      [23, false],
      [24, true],
    ] as const) {
      const token = "s".repeat(len);
      await db.update(userSettings).set({ calendarFeedToken: hashCalendarFeedToken(token) }).where(eq(userSettings.userId, SHORT));
      const found = await findUserByFeedToken(token);
      t.check(
        `a stored ${len}-char token ${expect ? "resolves" : "is refused by the length floor"}`,
        expect ? found?.userId === SHORT : found === null
      );
      if (!expect) t.check(`…and via the route → 404`, (await feed(token)).status === 404);
    }
    t.check("an empty token is refused", (await findUserByFeedToken("")) === null);
    t.check("`.ics` alone is refused", (await findUserByFeedToken(".ics")) === null);

    // --- Calendar feed: the route -----------------------------------------------------------
    console.log("\nGET /api/calendar/[token]…");
    await ensureUserSettings(OWNER);
    await ensureUserSettings(OTHER);
    const soon = new Date(Date.now() + 2 * 86_400_000);
    const ownContact = await insertContact(db, OWNER, 3, { fullName: "Owner Contact Person" });
    const otherContact = await insertContact(db, OTHER, 4, { fullName: "Other Account Secret Person" });
    await insertReminder(db, OWNER, ownContact.id, { title: "OWNER-REMINDER-ONE", dueDate: soon });
    // A foreign contactId on the owner's own reminder: the feed must not print that contact.
    await insertReminder(db, OWNER, otherContact.id, { title: "OWNER-REMINDER-FOREIGN-REF", dueDate: soon });
    await insertReminder(db, OTHER, otherContact.id, { title: "OTHER-ACCOUNT-REMINDER", dueDate: soon });
    const token = await mintCalendarFeedToken(OWNER);

    t.check("an unknown well-formed token → 404", (await feed("x".repeat(43))).status === 404);
    t.check("an unknown token with .ics → 404", (await feed(`${"y".repeat(43)}.ics`)).status === 404);

    const ok = await feed(`${token}.ics`);
    const ics = await ok.text();
    t.check("a valid token → 200", ok.status === 200, String(ok.status));
    t.check("…as text/calendar", (ok.headers.get("content-type") ?? "").startsWith("text/calendar"), String(ok.headers.get("content-type")));
    t.check("…and is not cacheable by a shared cache", (ok.headers.get("cache-control") ?? "").includes("private"));
    t.check("…containing the owner's reminders", ics.includes("OWNER-REMINDER-ONE") && ics.includes("OWNER-REMINDER-FOREIGN-REF"));
    t.check("…and the owner's own contact's name", ics.includes("Owner Contact Person"));
    t.check("…and NOT the other account's reminder", !ics.includes("OTHER-ACCOUNT-REMINDER"));
    t.check("…nor the other account's contact name, even where the owner's reminder points at it", !ics.includes("Other Account Secret Person"));
    const etag = ok.headers.get("etag") ?? "";
    t.check("a matching If-None-Match → 304", etag !== "" && (await feed(token, { "if-none-match": etag })).status === 304);
    t.check("the fetch is stamped", (await settingsOf(OWNER))?.calendarFeedLastFetchedAt instanceof Date);

    // Suspension: the token still exists, but the route goes quiet and writes nothing.
    await db
      .update(userSettings)
      .set({ suspendedAt: new Date(), calendarFeedLastFetchedAt: new Date(0) })
      .where(eq(userSettings.userId, OWNER));
    t.check("a suspended owner's token resolves to nothing", (await findUserByFeedToken(token)) === null);
    t.check("…and the route → 404", (await feed(token)).status === 404);
    t.check("…without stamping the fetch", (await settingsOf(OWNER))?.calendarFeedLastFetchedAt?.getTime() === 0);
    await db.update(userSettings).set({ suspendedAt: null }).where(eq(userSettings.userId, OWNER));
    t.check("lifting the suspension brings the feed back", (await feed(token)).status === 200);

    // --- Scan routes --------------------------------------------------------------------------
    console.log("\nPOST /api/scan/[token]/…");
    const malformed = "not-a-scan-token";
    const unknown = generateHandoffToken().token;
    for (const [label, tk] of [
      ["a malformed", malformed],
      ["an unknown", unknown],
    ] as const) {
      t.check(`finish with ${label} token → 404`, (await finish(tk)).status === 404);
      t.check(`pages with ${label} token → 404`, (await pages(tk)).status === 404);
    }

    const grant = await mintScanHandoff(OWNER);
    await db.update(userSettings).set({ suspendedAt: new Date() }).where(eq(userSettings.userId, OWNER));
    t.check("finish with a suspended owner's live token → 404", (await finish(grant.token)).status === 404);
    t.check("pages with a suspended owner's live token → 404", (await pages(grant.token)).status === 404);
    const stillThere = await db.query.captureHandoffs.findFirst({ where: eq(captureHandoffs.userId, OWNER) });
    t.check("…and the grant is neither consumed nor touched", stillThere?.status === "pending" && stillThere.pageCount === 0, JSON.stringify(stillThere?.status));
    const job = await db.query.captureJobs.findFirst({ where: eq(captureJobs.id, grant.captureJobId) });
    t.check("…and its capture job is still collecting", job?.status === "ingesting", job?.status);
    await db.update(userSettings).set({ suspendedAt: null }).where(eq(userSettings.userId, OWNER));
    const done = await finish(grant.token);
    t.check("control: the same token finishes once the owner is reinstated → 200", done.status === 200, String(done.status));
    t.check("…and is single-use", (await finish(grant.token)).status === 404);

    // --- Stealth: pinned current behaviour -------------------------------------------------
    console.log("\nStealth (pinned current behaviour — see header)…");
    await setStealth(ADMIN, false);
    const mode = await setStealth(ADMIN, true);
    await db.insert(userSettings).values({ userId: HELD, createdAt: new Date(mode.stealthSince!.getTime() + 60_000) });
    // An uninvited row created during stealth: `requireUserId` would refuse this account (see
    // smoke-extension-auth for the hold itself). Not evaluated here — that needs Clerk.
    const heldFeed = await mintCalendarFeedToken(HELD);
    const heldScan = await mintScanHandoff(HELD);
    t.check(
      "PINNED: the feed lookup does not consult stealth (a held owner's token would resolve)",
      (await findUserByFeedToken(heldFeed))?.userId === HELD
    );
    t.check("PINNED: the scan lookup does not consult stealth", (await findScanHandoff(heldScan.token))?.userId === HELD);
  } finally {
    await db.delete(siteSettings).where(eq(siteSettings.id, 1));
    if (siteBefore) await db.insert(siteSettings).values(siteBefore);
    (globalThis as { orbitSiteMode?: unknown }).orbitSiteMode = undefined;
    await db.delete(adminAuditLog).where(eq(adminAuditLog.adminUserId, ADMIN));
    await purgeUsers(db, ALL);
  }

  t.done("token routes");
});
