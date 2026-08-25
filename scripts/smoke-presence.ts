/**
 * Verifies live presence and the Clerk identity mirror.
 *
 * The assertions that matter are the negative ones. A presence window that is too wide
 * makes everyone who used Orbit in the last few minutes read as "active now", which does
 * not fail loudly — it just quietly stops distinguishing anything, which is the entire
 * point of the feature. Same for the identity mirror: writing unconditionally would work
 * fine and bump `updated_at` on every unrelated `user.updated` webhook forever.
 *
 * Run: npx tsx scripts/smoke-presence.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { liveUserIds, recordHeartbeat } from "../src/lib/presence";
import {
  HEARTBEAT_INTERVAL_MS,
  PRESENCE_WINDOW_MS,
  isLive,
} from "../src/lib/presence-window";
import {
  ensureUserSettings,
  setUserEmail,
  setUserIdentity,
} from "../src/lib/user-settings";

const PREFIX = "smoke-presence-";
const LIVE = `${PREFIX}live`;
const IDLE = `${PREFIX}idle`;
const NEVER = `${PREFIX}never`;
const ALL = [LIVE, IDLE, NEVER];

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function stamp(userId: string, at: Date | null) {
  const db = await getDb();
  await db
    .update(userSettings)
    .set({ lastActiveAt: at })
    .where(eq(userSettings.userId, userId));
}

async function read(userId: string) {
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });
  if (!row) throw new Error(`missing row for ${userId}`);
  return row;
}

async function cleanup() {
  const db = await getDb();
  await db.delete(userSettings).where(inArray(userSettings.userId, ALL));
}

async function main() {
  await cleanup();
  for (const id of ALL) await ensureUserSettings(id);

  const now = new Date();

  /* ------------------------------------------------------------------ the window itself */

  check(
    "the window is two heartbeat intervals",
    PRESENCE_WINDOW_MS === 2 * HEARTBEAT_INTERVAL_MS,
    `${PRESENCE_WINDOW_MS} vs ${HEARTBEAT_INTERVAL_MS}`
  );

  check(
    "a beat 30s ago counts as live",
    isLive(new Date(now.getTime() - 30_000), now)
  );

  // The load-bearing one. If this ever passes, the window has been widened and the
  // indicator has stopped meaning anything.
  check(
    "a beat 200s ago does NOT count as live",
    !isLive(new Date(now.getTime() - 200_000), now)
  );

  check(
    "one missed beat does not blink an active user out",
    isLive(new Date(now.getTime() - HEARTBEAT_INTERVAL_MS - 1_000), now)
  );

  check("a null stamp is never live", !isLive(null, now));

  /* ------------------------------------------------------------------------- the live set */

  await stamp(LIVE, new Date(now.getTime() - 20_000));
  await stamp(IDLE, new Date(now.getTime() - 60 * 60 * 1000));
  await stamp(NEVER, null);

  const live = await liveUserIds();
  check("the live set contains the recently-beating account", live.includes(LIVE));
  check("it excludes the idle account", !live.includes(IDLE));
  check("it excludes the account that has never beaten", !live.includes(NEVER));

  /* -------------------------------------------------------------------------- heartbeats */

  await recordHeartbeat(IDLE);
  const beaten = await read(IDLE);
  check(
    "a heartbeat makes an idle account live",
    isLive(beaten.lastActiveAt, new Date())
  );

  // Presence is not a settings change. If this regresses, `updated_at` starts meaning
  // "someone had a tab open", and every consumer of it is quietly poisoned.
  const beforeUpdatedAt = beaten.updatedAt.getTime();
  await recordHeartbeat(IDLE);
  const rebeaten = await read(IDLE);
  check(
    "a heartbeat does not touch updated_at",
    rebeaten.updatedAt.getTime() === beforeUpdatedAt
  );

  /* -------------------------------------------------- the request-path writer stands down */

  // `ensureUserSettings` refreshes `last_active_at` on a 15-minute throttle. With the
  // heartbeat keeping the column fresh, that check must short-circuit — otherwise the two
  // writers are both firing and the heartbeat made the request path more expensive, not
  // less.
  const fresh = await read(LIVE);
  const settled = await ensureUserSettings(LIVE);
  check(
    "ensureUserSettings issues no write against a heartbeat-fresh row",
    settled?.lastActiveAt?.getTime() === fresh.lastActiveAt?.getTime()
  );

  /* --------------------------------------------------------------------- identity mirror */

  await setUserEmail(LIVE, "Presence.Tester@Example.Test");
  await setUserIdentity(LIVE, {
    firstName: "  Ada  ",
    lastName: "Lovelace",
    imageUrl: "https://img.clerk.test/ada.png",
  });

  const named = await read(LIVE);
  check("first and last name are mirrored, trimmed", named.firstName === "Ada" && named.lastName === "Lovelace");
  check("the avatar URL is mirrored", named.profileImageUrl === "https://img.clerk.test/ada.png");
  check(
    "mirroring identity does not clobber the mirrored email",
    named.email === "presence.tester@example.test"
  );

  // Written only on change. `user.updated` fires for many unrelated profile edits, so an
  // unconditional UPDATE here would bump `updated_at` on every one of them.
  const stableAt = named.updatedAt.getTime();
  await setUserIdentity(LIVE, {
    firstName: "Ada",
    lastName: "Lovelace",
    imageUrl: "https://img.clerk.test/ada.png",
  });
  const again = await read(LIVE);
  check(
    "re-mirroring identical values writes nothing",
    again.updatedAt.getTime() === stableAt
  );

  // Empty strings are Clerk's way of saying "unset"; they must not become empty names.
  await setUserIdentity(NEVER, { firstName: "", lastName: "   ", imageUrl: null });
  const blank = await read(NEVER);
  check(
    "blank Clerk values normalise to null, not empty strings",
    blank.firstName === null && blank.lastName === null && blank.profileImageUrl === null
  );

  await cleanup();
  console.log("\nAll presence checks passed.");
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await cleanup().catch(() => {});
    process.exit(1);
  });
