/**
 * Speech usage accounting against a throwaway PGlite database.
 * Run: npx tsx scripts/smoke-speech-quota.ts
 */
import "./smoke/_env";

import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { speechUsage, userSettings } from "../src/db/schema";
import { isSpeechTagId } from "../src/lib/deepgram-params";
import { speechKindForOperation } from "../src/lib/speech-limits";
import { recordSpeechSeconds, speechAllowance } from "../src/lib/speech-quota";
import { mintSpeechTagId, speechTagIdFor, userIdForSpeechTagId } from "../src/lib/speech-tag-id";

const USER = "demo-user";
let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`); }
}

/**
 * Which meter a transcription spends from is decided by the OPERATION, not the call site.
 *
 * Pinned in source as well as in behaviour: `transcribeAudioWithAI` is the one place both
 * meeting chunk recovery and voice notes pass through, and it used to check and record
 * `"shortform"` unconditionally — so a meeting recovered chunk by chunk (a firewall blocking
 * `wss://`, say) spent Orbit's key against the wrong cap and the meeting cap never tripped.
 * A literal `"shortform"` reappearing in that block is exactly how the bug would come back.
 */
function meterFollowsTheOperation() {
  console.log("\nthe meter follows the operation");
  check("a meeting transcription meters as a meeting", speechKindForOperation("meeting.transcribe") === "meeting");
  check("a capture transcription meters as short-form", speechKindForOperation("capture.transcribe.audio") === "shortform");
  check("…as does anything else", speechKindForOperation("chat.answer") === "shortform");

  const ai = readFileSync("src/lib/ai.ts", "utf8");
  const start = ai.indexOf("if (deepgramEnabled())");
  const block = start === -1 ? "" : ai.slice(start, start + 2_500).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("ai.ts has a Deepgram transcription block to check", block.length > 0);
  check("…which derives the meter from the operation", /speechKindForOperation\(operation\)/.test(block));
  check("…and never hardcodes a kind", !/kind:\s*["']shortform["']/.test(block) && !/speechAllowance\([^)]*["']shortform["']/.test(block));
}

async function main() {
  const db = await getDb();
  meterFollowsTheOperation();
  await db.delete(speechUsage).where(eq(speechUsage.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.insert(userSettings).values({ userId: USER });

  console.log("\na free account");
  let allowance = await speechAllowance(USER, "meeting");
  check("has no meeting seconds", allowance.limit === 0 && allowance.exhausted);
  allowance = await speechAllowance(USER, "shortform");
  check("has 60 short-form minutes", allowance.limit === 3_600 && allowance.remaining === 3_600);

  console.log("\nrecording usage");
  await recordSpeechSeconds({ userId: USER, kind: "shortform", seconds: 90, source: "file" });
  allowance = await speechAllowance(USER, "shortform");
  check("spends what it recorded", allowance.used === 90 && allowance.remaining === 3_510);

  await recordSpeechSeconds({ userId: USER, kind: "shortform", seconds: 30, source: "file" });
  allowance = await speechAllowance(USER, "shortform");
  check("adds up across recordings", allowance.used === 120);

  console.log("\na meeting is one growing row");
  const sessionId = "11111111-1111-4111-8111-111111111111";
  await recordSpeechSeconds({ userId: USER, kind: "meeting", seconds: 600, source: "stream", sessionId });
  await recordSpeechSeconds({ userId: USER, kind: "meeting", seconds: 900, source: "stream", sessionId });
  const rows = await db.select().from(speechUsage).where(eq(speechUsage.sessionId, sessionId));
  check("one row per session", rows.length === 1, `${rows.length} rows`);
  check("the row holds the high-water mark", rows[0]?.seconds === 900);

  await recordSpeechSeconds({ userId: USER, kind: "meeting", seconds: 400, source: "stream", sessionId });
  const after = await db.select().from(speechUsage).where(eq(speechUsage.sessionId, sessionId));
  check("a late, smaller report never lowers it", after[0]?.seconds === 900);

  // A tag outlives the request inside Deepgram's usage records, which their zero-retention
  // flag does not cover — so the id in one must not be the account's own id. This is the
  // round trip the nightly job depends on: mint once, resolve back, and resolve nothing for
  // a value no account claims.
  console.log("\nthe short-form tag id is opaque, stable and resolvable");
  {
    const first = await speechTagIdFor(USER);
    check("an account gets a tag id on first use", Boolean(first && isSpeechTagId(first)), String(first));
    check("…which is not the user id, or anything derived from it visibly", first !== USER && !String(first).includes(USER));

    const second = await speechTagIdFor(USER);
    check("…and the same one on every later call", second === first, `${first} vs ${second}`);

    const stored = await db.query.userSettings.findFirst({
      where: eq(userSettings.userId, USER),
      columns: { speechTagId: true },
    });
    check("…stored on the settings row, where the job can index into it", stored?.speechTagId === first);

    check("the job resolves a tag id back to its account", (await userIdForSpeechTagId(first!)) === USER);
    check(
      "…and resolves nothing for a value no account claims",
      (await userIdForSpeechTagId(mintSpeechTagId())) === null
    );
    // Resolution does not go through `speech_usage`, which is the point: the job has to be
    // able to attribute Deepgram spend for an account whose beacons never arrived, and those
    // are exactly the accounts with no rows.
    const rows = await db.select().from(speechUsage).where(eq(speechUsage.userId, USER));
    check("…for an account whose recorded rows say nothing about the tag", rows.every((r) => r.requestId !== first));
  }

  console.log("\nanother user's usage is invisible");
  await recordSpeechSeconds({ userId: "someone-else", kind: "shortform", seconds: 3_000, source: "file" });
  allowance = await speechAllowance(USER, "shortform");
  check("still only this user's seconds", allowance.used === 120);

  await db.delete(speechUsage).where(eq(speechUsage.userId, "someone-else"));

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll speech quota checks passed");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
