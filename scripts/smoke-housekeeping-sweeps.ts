/**
 * The global sweeps the daily cron runs: abandoned meeting sessions (and their transcript
 * segments) past the TTL, expired phone-scan grants, and the retention windows of
 * `src/lib/retention.ts` (audit M-08). Run: npx tsx scripts/smoke-housekeeping-sweeps.ts
 */
import "./smoke/_env";

import { readFileSync } from "node:fs";
import { eq, inArray, like } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  captureHandoffs,
  cronRuns,
  emailSends,
  extensionUsage,
  feedback,
  feedbackScreenshots,
  gateEvents,
  meetingSessions,
  meetingTranscriptSegments,
  outboundWebhookDeliveries,
  rateLimitBuckets,
  speechUsage,
  webhookDeliveries,
  webhookEndpoints,
} from "../src/db/schema";
import { RETENTION, runRetentionSweeps } from "../src/lib/retention";
import { ABANDONED_SESSION_TTL_DAYS, sweepAbandonedMeetingSessions } from "../src/lib/meeting-sessions";
import { RATE_LIMITS, RATE_LIMIT_BUCKET_RETENTION_MS, pruneRateLimitBuckets } from "../src/lib/rate-limit";
import { sweepExpiredHandoffs } from "../src/lib/scan-handoff";
import { SHARED_FILL_BUDGET_MS } from "../src/lib/shared-avatar-upkeep";
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
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "smoke-sweeps:%"));
  await db.delete(cronRuns).where(like(cronRuns.job, "smoke-sweeps.%"));
  await db.delete(webhookDeliveries).where(like(webhookDeliveries.eventId, "smoke-sweeps-%"));
  await db.delete(webhookEndpoints).where(inArray(webhookEndpoints.userId, USERS));
  await db.delete(feedbackScreenshots).where(inArray(feedbackScreenshots.userId, USERS));
  await db.delete(feedback).where(inArray(feedback.userId, USERS));
  await db.delete(emailSends).where(inArray(emailSends.userId, USERS));
  await db.delete(gateEvents).where(inArray(gateEvents.userId, USERS));
  await db.delete(extensionUsage).where(inArray(extensionUsage.userId, USERS));
  await db.delete(speechUsage).where(inArray(speechUsage.userId, USERS));
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

    console.log("\nRate-limit buckets…");
    const ago = (ms: number) => new Date(Date.now() - ms);
    await db.insert(rateLimitBuckets).values([
      { bucket: "smoke-sweeps:old", windowStartedAt: ago(RATE_LIMIT_BUCKET_RETENTION_MS + 60_000), count: 3 },
      { bucket: "smoke-sweeps:fresh", windowStartedAt: ago(60_000), count: 3 },
      { bucket: "smoke-sweeps:day-old", windowStartedAt: ago(86_400_000 + 60_000), count: 3 },
    ]);
    await pruneRateLimitBuckets();
    const buckets = (await db.select({ bucket: rateLimitBuckets.bucket }).from(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "smoke-sweeps:%"))).map((r) => r.bucket).sort();
    check("a bucket idle past the retention is deleted, a recent one kept", JSON.stringify(buckets) === JSON.stringify(["smoke-sweeps:day-old", "smoke-sweeps:fresh"]), JSON.stringify(buckets));
    const longestWindowMs = Math.max(...Object.values(RATE_LIMITS).map((p) => p.windowSec)) * 1000;
    check("retention outlasts the longest bucket window, so a live window is never cut", RATE_LIMIT_BUCKET_RETENTION_MS >= 2 * longestWindowMs, String(longestWindowMs));

    console.log("\nRetention windows (M-08)…");
    check(
      "the windows are the plan's",
      RETENTION.cronRunsDays === 90 && RETENTION.webhookDeliveriesDays === 90 && RETENTION.webhookRecipientsDays === 30 &&
        RETENTION.outboundPayloadDays === 30 && RETENTION.feedbackScreenshotClosedDays === 90 &&
        RETENTION.meetingTranscriptAfterDigestDays === null && RETENTION.emailBodyDays === null &&
        RETENTION.gateEventsDays === 180 && RETENTION.extensionUsageDays === 180 && RETENTION.speechUsageDays === 180
    );
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

    await db.insert(cronRuns).values([
      { job: "smoke-sweeps.old", startedAt: daysAgo(91) },
      { job: "smoke-sweeps.new", startedAt: daysAgo(89) },
    ]);
    await db.insert(webhookDeliveries).values([
      { source: "resend", eventId: "smoke-sweeps-old", outcome: "handled", detail: { recipients: ["a@example.test"] }, createdAt: daysAgo(91) },
      { source: "resend", eventId: "smoke-sweeps-mid", outcome: "handled", detail: { recipients: ["b@example.test"], kind: "bounce" }, createdAt: daysAgo(31) },
      { source: "resend", eventId: "smoke-sweeps-new", outcome: "handled", detail: { recipients: ["c@example.test"] }, createdAt: daysAgo(29) },
    ]);
    const [endpoint] = await db.insert(webhookEndpoints).values({ userId: USERS[0], url: "https://example.test/h", secretEncrypted: "x" }).returning();
    await db.insert(outboundWebhookDeliveries).values([
      { userId: USERS[0], endpointId: endpoint.id, eventId: "e-old", eventType: "contact.created", payload: { name: "Ada" }, status: "delivered", deliveredAt: daysAgo(31) },
      { userId: USERS[0], endpointId: endpoint.id, eventId: "e-new", eventType: "contact.created", payload: { name: "Grace" }, status: "delivered", deliveredAt: daysAgo(29) },
      { userId: USERS[0], endpointId: endpoint.id, eventId: "e-pending", eventType: "contact.created", payload: { name: "Alan" }, status: "pending", createdAt: daysAgo(40) },
    ]);
    const [closedOld] = await db.insert(feedback).values({ userId: USERS[0], kind: "freeform", text: "old", status: "resolved", statusChangedAt: daysAgo(91) }).returning();
    const [closedNew] = await db.insert(feedback).values({ userId: USERS[0], kind: "freeform", text: "new", status: "resolved", statusChangedAt: daysAgo(10) }).returning();
    const [openOld] = await db.insert(feedback).values({ userId: USERS[0], kind: "freeform", text: "open", status: "new", createdAt: daysAgo(200) }).returning();
    const shot = (feedbackId: string, blobUrl: string | null) => ({
      feedbackId, userId: USERS[0], storage: blobUrl ? ("blob" as const) : ("inline" as const), blobUrl, inlineData: blobUrl ? null : "aGk=", contentType: "image/webp", byteSize: 2,
    });
    await db.insert(feedbackScreenshots).values([
      shot(closedOld.id, "https://store.public.blob.vercel-storage.com/feedback/old-abc.webp"),
      shot(closedOld.id, null),
      shot(closedNew.id, "https://store.public.blob.vercel-storage.com/feedback/new-abc.webp"),
      shot(openOld.id, "https://store.public.blob.vercel-storage.com/feedback/open-abc.webp"),
    ]);
    const digest = { title: "t", summary: "s", keyPoints: [], decisions: [], actionItems: [], blockers: [], openQuestions: [], participants: [], datedQuotes: [], notes: "" };
    const [savedMeeting] = await db.insert(meetingSessions).values({ userId: USERS[0], status: "saved", digest }).returning();
    const [analyzedMeeting] = await db.insert(meetingSessions).values({ userId: USERS[0], status: "analyzed", digest }).returning();
    await db.insert(meetingTranscriptSegments).values([
      { sessionId: savedMeeting.id, userId: USERS[0], seq: 0, startMs: 0, endMs: 1000, text: "said", engine: "whisper" },
      { sessionId: analyzedMeeting.id, userId: USERS[0], seq: 0, startMs: 0, endMs: 1000, text: "still being reviewed", engine: "whisper" },
    ]);
    const send = (status: "sent" | "queued", updatedAt: Date, key: string) => ({
      userId: USERS[0], provider: "demo" as const, fromEmail: "me@example.test", to: ["you@example.test"], subject: `s-${key}`,
      bodyText: `body ${key}`, bodyHtml: `<p>${key}</p>`, origin: "compose" as const, status, sendAt: updatedAt, rfcMessageId: `<${key}@smoke>`, updatedAt,
    });
    await db.insert(emailSends).values([send("sent", daysAgo(91), "old"), send("sent", daysAgo(89), "new"), send("queued", daysAgo(120), "queued")]);
    await db.insert(gateEvents).values([
      { userId: USERS[0], feature: "smoke", plan: "free", createdAt: daysAgo(181) },
      { userId: USERS[0], feature: "smoke", plan: "free", createdAt: daysAgo(179) },
    ]);
    await db.insert(extensionUsage).values([
      { userId: USERS[0], windowStartedAt: daysAgo(200), lastSeenAt: daysAgo(181) },
      { userId: USERS[1], windowStartedAt: daysAgo(200), lastSeenAt: daysAgo(10) },
    ]);
    await db.insert(speechUsage).values([
      { userId: USERS[0], kind: "shortform", seconds: 5, source: "file", createdAt: daysAgo(181) },
      { userId: USERS[1], kind: "shortform", seconds: 5, source: "file", createdAt: daysAgo(179) },
    ]);

    const blobsDeleted: string[] = [];
    // The two user-content windows are off by default (decision 8); exercised here at the
    // plan's suggested values so the statements stay tested for when they are turned on.
    const stats = await runRetentionSweeps({
      deleteBlob: async (url) => void blobsDeleted.push(url),
      windows: { meetingTranscriptAfterDigestDays: 0, emailBodyDays: 90 },
    });

    const jobs = (await db.select({ job: cronRuns.job }).from(cronRuns).where(like(cronRuns.job, "smoke-sweeps.%"))).map((r) => r.job);
    check("cron_runs past 90 days go, newer stay", JSON.stringify(jobs) === JSON.stringify(["smoke-sweeps.new"]), JSON.stringify(jobs));
    const deliveries = await db.select().from(webhookDeliveries).where(like(webhookDeliveries.eventId, "smoke-sweeps-%"));
    const byId = new Map(deliveries.map((d) => [d.eventId, d.detail]));
    check("webhook_deliveries past 90 days go", !byId.has("smoke-sweeps-old") && byId.size === 2);
    check("recipients are dropped after 30 days, the rest of the detail kept", !("recipients" in (byId.get("smoke-sweeps-mid") ?? {})) && byId.get("smoke-sweeps-mid")?.kind === "bounce");
    check("…and kept before then", Array.isArray(byId.get("smoke-sweeps-new")?.recipients));
    const outbound = new Map((await db.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.endpointId, endpoint.id))).map((d) => [d.eventId, d]));
    check("a payload delivered 30+ days ago is emptied, the row kept", JSON.stringify(outbound.get("e-old")?.payload) === "{}" && outbound.get("e-old")?.status === "delivered");
    check("…a recent one and an undelivered one keep theirs", (outbound.get("e-new")?.payload as { name?: string })?.name === "Grace" && (outbound.get("e-pending")?.payload as { name?: string })?.name === "Alan");
    const shots = await db.select().from(feedbackScreenshots).where(inArray(feedbackScreenshots.userId, USERS));
    check("screenshots of feedback resolved 90+ days ago go, rows and blobs", !shots.some((x) => x.feedbackId === closedOld.id) && JSON.stringify(blobsDeleted) === JSON.stringify(["https://store.public.blob.vercel-storage.com/feedback/old-abc.webp"]), JSON.stringify(blobsDeleted));
    check("…recently resolved and still-open feedback keeps its screenshots", shots.some((x) => x.feedbackId === closedNew.id) && shots.some((x) => x.feedbackId === openOld.id));
    check("…and the feedback text itself stays", (await db.select().from(feedback).where(eq(feedback.id, closedOld.id))).length === 1);
    const kept = await db.select().from(meetingTranscriptSegments).where(inArray(meetingTranscriptSegments.sessionId, [savedMeeting.id, analyzedMeeting.id]));
    check("a saved meeting with its digest loses its transcript", !kept.some((x) => x.sessionId === savedMeeting.id));
    check("…one still being reviewed keeps it", kept.some((x) => x.sessionId === analyzedMeeting.id));
    const sends = new Map((await db.select().from(emailSends).where(inArray(emailSends.userId, USERS))).map((r) => [r.subject, r]));
    check("a settled send's body is cleared after 90 days, the envelope kept", sends.get("s-old")?.bodyText === "" && sends.get("s-old")?.bodyHtml === null && sends.get("s-old")?.status === "sent");
    check("…a newer one and a queued one keep theirs", sends.get("s-new")?.bodyText === "body new" && sends.get("s-queued")?.bodyText === "body queued");
    check("gate_events past 180 days go", (await db.select().from(gateEvents).where(inArray(gateEvents.userId, USERS))).length === 1);
    const ext = (await db.select().from(extensionUsage).where(inArray(extensionUsage.userId, USERS))).map((r) => r.userId);
    check("extension_usage unused for 180 days goes", JSON.stringify(ext) === JSON.stringify([USERS[1]]), JSON.stringify(ext));
    const speech = (await db.select().from(speechUsage).where(inArray(speechUsage.userId, USERS))).map((r) => r.userId);
    check("speech_usage past 180 days goes", JSON.stringify(speech) === JSON.stringify([USERS[1]]), JSON.stringify(speech));
    check("the sweep reports what it did", stats.cronRunsPruned >= 1 && stats.webhookRecipientsStripped >= 1 && stats.outboundPayloadsCleared >= 1 && stats.feedbackScreenshotsPruned >= 2 && stats.emailBodiesCleared >= 1, JSON.stringify(stats));

    const route = readFileSync("src/app/api/imports/process-stalled/route.ts", "utf8");
    check("the hourly sweep runs the retention windows in their own try block", /try \{\s*\/\/[^\n]*\n[^\n]*\n\s*Object\.assign\(stats, await runRetentionSweeps\(\)\)/.test(route));
    check("…and the interest-list token backfill", route.includes("await backfillInterestListTokens()"));
    check("the daily cron calls both sweeps", route.includes("sweepAbandonedMeetingSessions()") && route.includes("sweepExpiredHandoffs()"));
    check("…and prunes the rate-limit buckets", route.includes("pruneRateLimitBuckets()"));
    const stepOf = (call: string) => {
      const at = route.indexOf(call);
      // Each stage is `if (stage("…")) try { … }`, so its block opens at the nearest `try {`.
      const open = route.lastIndexOf(" try {", at);
      return { at, open, close: route.indexOf("\n    }", at) };
    };
    const fill = stepOf("await fillSharedAvatars()");
    const orphans = stepOf("await sweepOrphanedSharedAvatars()");
    check(
      "the shared-photo fill and orphan sweep each run in their own try block",
      fill.at > 0 && orphans.at > 0 && fill.open !== orphans.open && fill.close < orphans.open,
      JSON.stringify([fill, orphans])
    );
    check("…and are recorded in the run summary", route.includes("sharedAvatarsFilled") && route.includes("sharedAvatarsSwept"));
    const embeddingSweep = route.indexOf("runEmbeddingBackfill(staleUser");
    check(
      "…and run after the embedding sweep, so slow lookups never push it past maxDuration",
      embeddingSweep > 0 && fill.open > embeddingSweep && orphans.open > embeddingSweep,
      JSON.stringify({ embeddingSweep, fill: fill.open })
    );
    check("…within a 20s fill budget", SHARED_FILL_BUDGET_MS <= 20_000, String(SHARED_FILL_BUDGET_MS));
  } finally {
    await cleanup();
  }
});
