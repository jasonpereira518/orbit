/**
 * The extension's measurement: first seen, version, install, action and uninstall.
 *
 * Drives the real route handlers (`/api/extension/me`, `/event-roster`, `/follow-ups`,
 * `/resolve`, `/uninstalled`) with raw requests, authenticated through the local-dev secret the
 * routes already support, against a throwaway PGlite. Pins (audit D10):
 *   - `extension_usage.first_seen_at` is written once and never moves; `version` follows the
 *     latest build that identified itself and ignores anything that is not a plain x.y.z;
 *   - `extension_installed` is one event per account, only when the install header rides on an
 *     authenticated request, with the validated version and the browser family;
 *   - `extension_action` fires for the user-action routes (with the page adapter's site) and
 *     NOT for the session probe, background resolve/parse or the contact search;
 *   - a validation failure is not an action, a handler failure is ok=false;
 *   - the unauthenticated uninstall page always answers 204, records a plain version only, no
 *     user, and cannot be looped to inflate the count;
 *   - the extension source sends the headers, tags the install tab and registers the URL.
 *
 * Run: npx tsx scripts/smoke-extension-telemetry.ts
 */
import "./smoke/_env";

import { readFileSync } from "node:fs";
import { eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { events, extensionUsage, productEvents, rateLimitBuckets, userSettings } from "../src/db/schema";
import { run } from "./smoke/_env";
import { setSurfaceComingSoon } from "../src/lib/surface-visibility";

const USER = "user_smoke_ext_telemetry";
const SECRET = "smoke-extension-dev-secret";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const env = process.env as Record<string, string | undefined>;

/** A luma roster page, as the adapter would send it. */
const rosterPage = {
  schemaVersion: 1,
  site: "luma",
  adapterVersion: "event-roster-1",
  kind: "list",
  url: "https://lu.ma/smoke-ext-telemetry",
  sourceUrl: "https://lu.ma/smoke-ext-telemetry",
  capturedAt: new Date().toISOString(),
  identity: Object.fromEntries(
    ["name", "headline", "title", "company", "location", "school", "email", "handle", "profileUrl", "photoUrl"].map((k) => [k, null])
  ),
  roster: { title: "Smoke Telemetry Mixer", guests: [{ name: "Ada Lovelace" }] },
  text: { blob: "", truncated: false, charCount: 0, fromSelection: false },
  warnings: [],
};

run(async () => {
  const db = await getDb();
  // The routes accept a shared secret only under NODE_ENV=development, which also makes the
  // account "local" and would seed a demo workspace into the shared throwaway database.
  env.NODE_ENV = "development";
  env.ORBIT_DEMO_DATA = "off";
  env.EXTENSION_DEV_SECRET = SECRET;
  env.EXTENSION_DEV_USER_ID = USER;

  const { GET: me } = await import("../src/app/api/extension/me/route");
  const { POST: roster } = await import("../src/app/api/extension/event-roster/route");
  const { POST: followUps } = await import("../src/app/api/extension/follow-ups/route");
  const { POST: resolve } = await import("../src/app/api/extension/resolve/route");
  const { POST: saveContact, GET: searchContacts } = await import("../src/app/api/extension/contacts/route");
  const { GET: uninstalled } = await import("../src/app/api/extension/uninstalled/route");
  const { browserFrom, extensionVersionFrom, eventSiteFrom } = await import("../src/lib/extension/telemetry");

  const cleanup = async () => {
    await db.delete(productEvents).where(eq(productEvents.userId, USER));
    await db.delete(productEvents).where(eq(productEvents.name, "extension_uninstalled"));
    await db.delete(extensionUsage).where(eq(extensionUsage.userId, USER));
    await db.delete(events).where(eq(events.userId, USER));
    await db.delete(userSettings).where(eq(userSettings.userId, USER));
    await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "extension.uninstalled:%"));
  };
  await cleanup();

  const headers = (extra: Record<string, string> = {}) => ({
    "content-type": "application/json",
    "x-orbit-dev-secret": SECRET,
    "user-agent": "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0",
    ...extra,
  });
  const get = (path: string, extra: Record<string, string> = {}) => new Request(`https://orbit.test/api/extension${path}`, { method: "GET", headers: headers(extra) });
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
    new Request(`https://orbit.test/api/extension${path}`, { method: "POST", headers: headers(extra), body: JSON.stringify(body) });
  const eventsOf = async (name: string, userId: string | null = USER) =>
    (await db.select().from(productEvents).where(eq(productEvents.name, name))).filter((e) => e.userId === userId);
  const settle = async (name: string, want: number, userId: string | null = USER) => {
    for (let i = 0; i < 80; i++) {
      if ((await eventsOf(name, userId)).length >= want) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    return eventsOf(name, userId);
  };
  const usage = async () => (await db.select().from(extensionUsage).where(eq(extensionUsage.userId, USER)))[0];

  console.log("pure helpers…");
  check("a plain x.y.z version is accepted", extensionVersionFrom(new Headers({ "x-orbit-extension-version": "1.12.3" })) === "1.12.3");
  for (const bad of ["1.2", "1.2.3-beta", "v1.2.3", "1.2.3; drop", "", "1.2.3.4", "99999.1.1"]) {
    check(`"${bad}" is not a version`, extensionVersionFrom(new Headers({ "x-orbit-extension-version": bad })) === null);
  }
  check("no header is no version", extensionVersionFrom(new Headers()) === null);
  check(
    "the browser family is read conservatively",
    browserFrom("Mozilla/5.0 Chrome/120 Safari/537 Edg/120") === "edge" &&
      browserFrom("Mozilla/5.0 Chrome/120 Safari/537") === "chrome" &&
      browserFrom("Mozilla/5.0 Chrome/120 OPR/100") === "other" &&
      browserFrom("Mozilla/5.0 Gecko Firefox/121") === "other" &&
      browserFrom(null) === "other"
  );
  check("a page's site becomes the event's site", eventSiteFrom("luma") === "luma" && eventSiteFrom("x") === "other" && eventSiteFrom("generic") === "other" && eventSiteFrom(undefined) === "other");

  console.log("\nfirst seen and version…");
  const probe = await me(get("/me", { "x-orbit-extension-version": "1.2.3", "x-orbit-install": "1" }));
  check("the session probe answers", probe.status === 200, String(probe.status));
  const first = await usage();
  check("first_seen_at is set by the first authenticated request", first?.firstSeenAt instanceof Date);
  check("…with the version it reported", first?.version === "1.2.3");
  await new Promise((r) => setTimeout(r, 20));
  await me(get("/me", { "x-orbit-extension-version": "1.3.0" }));
  const second = await usage();
  check("first_seen_at never moves", second?.firstSeenAt?.getTime() === first?.firstSeenAt?.getTime());
  check("version follows the latest build", second?.version === "1.3.0");
  await me(get("/me", { "x-orbit-extension-version": "1.4.0-beta" }));
  await me(get("/me"));
  check("a malformed or absent version keeps the last good one", (await usage())?.version === "1.3.0");

  console.log("\ninstall…");
  const installed = await settle("extension_installed", 1);
  check("one extension_installed, with version and browser", installed.length === 1 && installed[0]?.properties.version === "1.2.3" && installed[0]?.properties.browser === "edge" && installed[0]?.surface === "extension", JSON.stringify(installed.map((e) => e.properties)));
  await me(get("/me", { "x-orbit-extension-version": "1.3.0", "x-orbit-install": "1" }));
  await new Promise((r) => setTimeout(r, 120));
  check("the install header again does not count the account twice", (await eventsOf("extension_installed")).length === 1);
  check("a probe without the header is not an install", (await eventsOf("extension_installed")).length === 1 && (await eventsOf("extension_action")).length === 0);

  console.log("\nactions…");
  // Events are not released to an ordinary account by default: the save is refused, which is an
  // attempted action that failed.
  const refused = await roster(post("/event-roster", { page: rosterPage }, { "x-orbit-extension-version": "1.3.0" }));
  check("a refused roster save is a clean 404", refused.status === 404, String(refused.status));
  const refusedEvents = await settle("extension_action", 1);
  check(
    "…recorded as the action that was attempted, ok=false, with the page adapter's site",
    refusedEvents.length === 1 && refusedEvents[0]?.properties.action === "event_roster" && refusedEvents[0]?.properties.site === "luma" && refusedEvents[0]?.properties.ok === false,
    JSON.stringify(refusedEvents.map((a) => a.properties))
  );
  await setSurfaceComingSoon(USER, "page.events", false);
  const saved = await roster(post("/event-roster", { page: rosterPage }, { "x-orbit-extension-version": "1.3.0" }));
  check("the roster save works once released", saved.status === 200, `${saved.status} ${await saved.clone().text()}`.slice(0, 200));
  const actions = await settle("extension_action", 2);
  check(
    "a user action records action, the page adapter's site and ok",
    actions.length === 2 && actions[1]?.properties.action === "event_roster" && actions[1]?.properties.site === "luma" && actions[1]?.properties.ok === true && actions[1]?.surface === "extension",
    JSON.stringify(actions.map((a) => a.properties))
  );
  await setSurfaceComingSoon(USER, "page.events", true); // back to the code default
  const failed = await followUps(post("/follow-ups", { contactId: "00000000-0000-4000-8000-000000000000", inDays: 3 }));
  check("a follow-up for a contact that is not there fails cleanly", failed.status === 404, String(failed.status));
  const afterFail = await settle("extension_action", 3);
  const failedEvent = afterFail.find((a) => a.properties.action === "schedule_follow_up");
  check("…and is an action with ok=false, site 'other' (no adapter page)", failedEvent?.properties.ok === false && failedEvent.properties.site === "other", JSON.stringify(failedEvent?.properties));

  const countBefore = (await eventsOf("extension_action")).length;
  const badBody = await saveContact(post("/contacts", { mode: "create" }));
  check("a body that fails validation is refused", badBody.status === 400, String(badBody.status));
  await resolve(post("/resolve", { page: { ...rosterPage, site: "linkedin", kind: "person", roster: undefined } }));
  await searchContacts(get("/contacts?q=ada"));
  await me(get("/me"));
  await new Promise((r) => setTimeout(r, 150));
  check(
    "validation failures, resolve, contact search and the probe are NOT actions",
    (await eventsOf("extension_action")).length === countBefore,
    `${(await eventsOf("extension_action")).length} vs ${countBefore}`
  );
  check("…and the actions carry no page content", !JSON.stringify(await eventsOf("extension_action")).includes("Ada") && !JSON.stringify(await eventsOf("extension_action")).includes("lu.ma"));

  console.log("\nattribution, lazily…");
  const acct = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, USER) });
  check("an extension-only account is attributed after its first request", acct?.signupAttributedAt != null);

  console.log("\nuninstall…");
  const hit = (qs: string, ip = "198.51.100.77") =>
    uninstalled(new Request(`https://orbit.test/api/extension/uninstalled${qs}`, { headers: { "x-forwarded-for": ip, "user-agent": "Mozilla/5.0 Secret-UA", referer: "https://example.test/private?token=1" } }));
  const ok = await hit("?v=1.3.0");
  check("an uninstall answers 204 with no body", ok.status === 204 && (await ok.text()) === "");
  const gone = await settle("extension_uninstalled", 1, null);
  check("…and records the version, with no user, session or other field", gone.length === 1 && gone[0]?.properties.version === "1.3.0" && gone[0]?.userId === null && gone[0]?.sessionId === null && Object.keys(gone[0]!.properties).join() === "version");
  check("…nothing from the request is on the row", !JSON.stringify(gone[0]).includes("198.51.100") && !JSON.stringify(gone[0]).includes("Secret-UA") && !JSON.stringify(gone[0]).includes("token"));
  for (const qs of ["", "?v=", "?v=1.3", "?v=1.3.0-beta", "?v=%3Cscript%3E", "?v=1.3.0&v=evil&email=a@b.c"]) {
    const res = await hit(qs, `198.51.100.${qs.length + 1}`);
    check(`${qs || "(no query)"} still answers 204`, res.status === 204);
  }
  await new Promise((r) => setTimeout(r, 150));
  const uninstallRows = await eventsOf("extension_uninstalled", null);
  check("only a plain version is recorded (the one valid ?v= among the junk adds one)", uninstallRows.length === 2 && uninstallRows.every((e) => /^\d+\.\d+\.\d+$/.test(String(e.properties.version))), String(uninstallRows.length));
  for (let i = 0; i < 25; i++) await hit("?v=2.0.0", "198.51.100.200");
  await new Promise((r) => setTimeout(r, 300));
  const flooded = (await eventsOf("extension_uninstalled", null)).filter((e) => e.properties.version === "2.0.0").length;
  check("a loop from one address is capped by the limiter, and every answer is still 204", flooded > 0 && flooded <= 10, String(flooded));

  console.log("\nthe extension source…");
  const background = readFileSync("extension/src/background/index.ts", "utf8");
  const api = readFileSync("extension/src/lib/api.ts", "utf8");
  check("the install tab carries utm_source=extension, utm_medium=install and the manifest version", /utm_source:\s*"extension"/.test(background) && /utm_medium:\s*"install"/.test(background) && /utm_campaign:\s*VERSION/.test(background) && /getManifest\(\)\.version/.test(background));
  check("the uninstall URL is registered with the version", /setUninstallURL\(/.test(background) && /api\/extension\/uninstalled\?v=/.test(background));
  check("every request sends the version header; /me sends the install marker once", /x-orbit-extension-version/.test(api) && /x-orbit-install/.test(api) && /clearInstallPending/.test(api) && /orbitInstallPending/.test(background));

  await cleanup();
  delete env.NODE_ENV;
  delete env.EXTENSION_DEV_SECRET;
  delete env.ORBIT_DEMO_DATA;
  delete env.EXTENSION_DEV_USER_ID;
  console.log("\nextension telemetry: all checks passed");
});
