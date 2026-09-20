/**
 * A rejected Wispr key is remembered per key, not per user: replacing the key clears it.
 * Run: npx tsx scripts/smoke-wispr-key-rejection.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { errorEvents } from "../src/db/schema";
import { recordWisprKeyRejected, wisprKeyFingerprint, wisprKeyWasRejected } from "../src/lib/wispr";

const USER = "smoke-wispr-reject-user";
const OTHER = "smoke-wispr-reject-other";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

run(async () => {
  const db = await getDb();
  const clean = () => db.delete(errorEvents).where(and(eq(errorEvents.source, "wispr.transcribe")));
  await clean();
  check("nothing recorded, nothing rejected", !(await wisprKeyWasRejected(USER, "key-a")));
  await recordWisprKeyRejected(USER, "key-a", 401);
  check("the rejected key reads as rejected", await wisprKeyWasRejected(USER, "key-a"));
  check("a replacement key does not", !(await wisprKeyWasRejected(USER, "key-b")));
  check("another user is unaffected", !(await wisprKeyWasRejected(OTHER, "key-a")));
  await new Promise((r) => setTimeout(r, 20));
  await recordWisprKeyRejected(USER, "key-b", 403);
  check("the newest rejection is what counts", (await wisprKeyWasRejected(USER, "key-b")) && !(await wisprKeyWasRejected(USER, "key-a")));
  const rows = await db.select().from(errorEvents).where(eq(errorEvents.userId, USER));
  check("the key itself is never stored", rows.every((r) => !JSON.stringify(r).includes("key-a") && !JSON.stringify(r).includes("key-b")));
  check("the fingerprint is 16 hex characters", /^[0-9a-f]{16}$/.test(wisprKeyFingerprint("key-a")));
  await clean();
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll Wispr rejection checks passed.");
});
