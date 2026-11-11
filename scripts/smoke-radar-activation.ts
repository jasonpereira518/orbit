/**
 * Radar is off by default, and "Turn on Radar" (schema v225). On a throwaway PGlite. Checks:
 *   - a new account starts off: the activation read says so and lists its people, closest
 *     first, with no photo bytes (only browser-safe URLs or null);
 *   - turning on stamps the first time once, clears a pause, and the read flips to on;
 *   - turning off and on again keeps the first stamp;
 *   - the scene's layout: stable per network, three rings, every node an image, a tiny network
 *     drawn with planets, and the outer ring inside a 375px phone;
 *   - the nav's "new suggestions" count: only pending, unexpired cards created after the
 *     last /radar open, and opening /radar clears it;
 *   - the timeline: beats in order, and long enough to feel like something happened.
 * The gates that keep an off account from running (nightly claim, first build, digest) are
 * pinned in smoke-radar-run and smoke-radar-digest. Leaves nothing behind.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, recommendations, userSettings } from "../src/db/schema";
import {
  BEAT,
  PLANETS,
  RING_CAPACITY,
  placeNodes,
  ringLayout,
} from "../src/lib/radar/activation-scene";
import { loadRadarActivation } from "../src/lib/radar/page-data";
import { loadRadarState, turnOnRadarForUser } from "../src/lib/radar/run";
import { countNewRadarSuggestions, stampRadarOpened } from "../src/lib/radar/store";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-radar-activation-user";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function reset() {
  const db = await getDb();
  await db.delete(recommendations).where(eq(recommendations.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(inArray(userSettings.userId, [USER]));
}

async function main() {
  const db = await getDb();
  await reset();
  await ensureUserSettings(USER);
  await db.insert(contacts).values([
    { userId: USER, fullName: "Close Cara", closeness: 90, profileImageUrl: "https://example.com/cara.jpg" },
    { userId: USER, fullName: "Middle Mo", closeness: 50 },
    { userId: USER, fullName: "Base64 Bea", closeness: 70, profileImageUrl: "data:image/png;base64,AAAA" },
    { userId: USER, fullName: "Unknown Uma" },
  ]);

  console.log("\na new account starts off");
  const off = await loadRadarActivation(USER);
  check("Radar is off", off.on === false);
  check("its people are listed closest first", off.faces.map((f) => f.name).join(",") === "Close Cara,Base64 Bea,Middle Mo,Unknown Uma", off.faces.map((f) => f.name).join(","));
  check("no photo bytes leave the database", off.faces.every((f) => f.photo === null || !f.photo.startsWith("data:")), JSON.stringify(off.faces.map((f) => f.photo)));
  check("a stored photo becomes the avatar route", off.faces[1]?.photo?.startsWith("/api/avatars/") === true, String(off.faces[1]?.photo));
  check("the run state reads off as paused", (await loadRadarState(USER))?.paused === true);

  console.log("\nturning it on");
  await db.update(userSettings).set({ radarPaused: 1 }).where(eq(userSettings.userId, USER));
  await turnOnRadarForUser(USER);
  const on = await loadRadarActivation(USER);
  check("Radar is on, even from paused", on.on === true);
  check("the scene isn't loaded once on", on.faces.length === 0);
  const [first] = await db.select({ at: userSettings.radarEnabledAt }).from(userSettings).where(eq(userSettings.userId, USER));
  check("the first time is stamped", first?.at instanceof Date);

  console.log("\noff and on again");
  await db.update(userSettings).set({ radarPaused: 1 }).where(eq(userSettings.userId, USER));
  const again = await loadRadarActivation(USER);
  check("off again shows the Turn on screen", again.on === false && again.faces.length === 4);
  await turnOnRadarForUser(USER);
  const [second] = await db.select({ at: userSettings.radarEnabledAt }).from(userSettings).where(eq(userSettings.userId, USER));
  check("the first stamp is never overwritten", second?.at?.getTime() === first?.at?.getTime());

  console.log("\nnew suggestions since /radar was last opened");
  {
    const DAY = 86_400_000;
    const people = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.userId, USER));
    const card = (contactId: string, over: Partial<typeof recommendations.$inferInsert> = {}) =>
      db.insert(recommendations).values({
        userId: USER,
        contactId,
        kind: "reconnect",
        score: 40,
        bucket: "today",
        expiresAt: new Date(Date.now() + 30 * DAY),
        inputsHash: "h",
        reasons: [{ code: "dormant", label: "Quiet", points: 30 }],
        ...over,
      });
    const opened = new Date(Date.now() - DAY);
    await card(people[0]!.id, { createdAt: new Date(opened.getTime() - DAY) });
    await card(people[1]!.id, { createdAt: new Date(opened.getTime() + 3_600_000) });
    await card(people[2]!.id, { createdAt: new Date(opened.getTime() + 3_600_000), status: "dismissed" });
    await card(people[3]!.id, { createdAt: new Date(opened.getTime() + 3_600_000), expiresAt: new Date(Date.now() - 60_000) });
    check("never opened: every live card is new", (await countNewRadarSuggestions(USER, null)) === 2);
    check("only the live card created after the last open is new", (await countNewRadarSuggestions(USER, opened)) === 1);
    await stampRadarOpened(USER);
    const [row] = await db.select({ at: userSettings.radarOpenedAt }).from(userSettings).where(eq(userSettings.userId, USER));
    check("opening /radar stamps the account", row?.at instanceof Date);
    check("and nothing is new after it", (await countNewRadarSuggestions(USER, row?.at ?? null)) === 0);
    await db.delete(recommendations).where(eq(recommendations.userId, USER));
  }

  console.log("\nthe scene's layout");
  const faces = Array.from({ length: 40 }, (_, i) => ({ contactId: `c${i}`, name: `P${i}`, photo: i % 3 ? `/p/${i}.jpg` : null }));
  const nodes = placeNodes(faces);
  const total = RING_CAPACITY.reduce((a, b) => a + b, 0);
  check("at most the rings' capacity", nodes.length === total, String(nodes.length));
  check("rings fill closest first", nodes.slice(0, RING_CAPACITY[0]).every((n) => n.ring === 0));
  check("stable for the same network", JSON.stringify(placeNodes(faces)) === JSON.stringify(nodes));
  check("every node is an image: a photo or a planet", nodes.every((n) => n.src.length > 0 && PLANETS.some((p) => n.planet.endsWith(`${p}.webp`))));
  check("people without a photo are drawn as a planet", nodes.filter((_, i) => i % 3 === 0).every((n) => n.src === n.planet));
  const tiny = placeNodes(faces.slice(0, 2));
  check("a tiny network is drawn with planets only", tiny.length > 0 && tiny.every((n) => n.src === n.planet));
  for (const [w, h] of [
    [375, 812],
    [1440, 900],
  ] as const) {
    const l = ringLayout(w, h);
    const reach = l.radii[2] + l.nodeRadius[2] + 22; // + the ping ring
    check(`the outer ring fits a ${w}×${h} screen`, reach * 2 <= Math.min(w, h), String(Math.round(reach * 2)));
  }

  console.log("\nthe timeline");
  const beats = Object.values(BEAT);
  check("the beats run in order", beats.every((b, i) => i === 0 || b > beats[i - 1]!), beats.join(","));
  check("the play lasts at least five seconds", BEAT.end >= 5000, String(BEAT.end));

  await reset();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll Radar activation checks passed.");
}

run(main);
