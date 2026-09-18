/**
 * The global sweeps the daily cron runs: abandoned meeting sessions (and their transcript
 * segments) past the TTL, and expired phone-scan grants. Run: npx tsx scripts/smoke-housekeeping-sweeps.ts
 */
import "./smoke/_env";

import { readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { captureHandoffs, meetingSessions, meetingTranscriptSegments } from "../src/db/schema";
import { ABANDONED_SESSION_TTL_DAYS, sweepAbandonedMeetingSessions } from "../src/lib/meeting-sessions";
import { sweepExpiredHandoffs } from "../src/lib/scan-handoff";
import { run } from "./smoke/_env";

const USERS = ["smoke-sweeps-a", "smoke-sweeps-b"];

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/** The smoke runner shares one PGlite across scripts, so this leaves nothing behind. */
async function cleanup() {
  const db = await getDb();
  await db.delete(meetingTranscriptSegments).where(inArray(meetingTranscriptSegments.userId, USERS));
  await db.delete(meetingSessions).where(inArray(meetingSessions.userId, USERS));
  await db.delete(captureHandoffs).where(inArray(captureHandoffs.userId, USERS));
}

run(async () => {
  const db = await getDb();
  await cleanup();
  try {
    const old = new Date(Date.now() - (ABANDONED_SESSION_TTL_DAYS + 1) * 86_400_000);

    const [abandoned] = await db.insert(meetingSessions).values({ userId: USERS[0], status: "ended", updatedAt: old }).returning();
    const [discarded] = await db.insert(meetingSessions).values({ userId: USERS[1], status: "discarded" }).returning();
    const [fresh] = await db.insert(meetingSessions).values({ userId: USERS[0], status: "recording" }).returning();
    const [savedOld] = await db.insert(meetingSessions).values({ userId: USERS[1], status: "saved", updatedAt: old }).returning();
    await db.insert(meetingTranscriptSegments).values({ sessionId: abandoned.id, userId: USERS[0], seq: 0, startMs: 0, endMs: 1000, text: "hello", engine: "whisper" });

    console.log("Meeting sessions…");
    const swept = await sweepAbandonedMeetingSessions();
    const left = (await db.select({ id: meetingSessions.id }).from(meetingSessions).where(inArray(meetingSessions.userId, USERS))).map((r) => r.id);
    check("an abandoned session past the TTL is swept, across users", !left.includes(abandoned.id) && !left.includes(discarded.id), JSON.stringify(left));
    check("a live recording and a saved session are kept", left.includes(fresh.id) && left.includes(savedOld.id));
    check("the sweep reports what it removed", swept >= 2, String(swept));
    const segs = await db.select().from(meetingTranscriptSegments).where(eq(meetingTranscriptSegments.sessionId, abandoned.id));
    check("its transcript went with it", segs.length === 0);

    console.log("\nScan handoffs…");
    await db.insert(captureHandoffs).values([
      { userId: USERS[0], tokenHash: "smoke-sweeps-expired", expiresAt: new Date(Date.now() - 60_000) },
      { userId: USERS[0], tokenHash: "smoke-sweeps-live", expiresAt: new Date(Date.now() + 600_000) },
    ]);
    const removed = await sweepExpiredHandoffs();
    const handoffs = await db.select({ tokenHash: captureHandoffs.tokenHash }).from(captureHandoffs).where(inArray(captureHandoffs.userId, USERS));
    check("the expired grant is gone, the live one kept", JSON.stringify(handoffs.map((h) => h.tokenHash)) === JSON.stringify(["smoke-sweeps-live"]), JSON.stringify(handoffs));
    check("the sweep reports a count", removed >= 1, String(removed));

    const route = readFileSync("src/app/api/imports/process-stalled/route.ts", "utf8");
    check("the daily cron calls both sweeps", route.includes("sweepAbandonedMeetingSessions()") && route.includes("sweepExpiredHandoffs()"));
  } finally {
    await cleanup();
  }
});
