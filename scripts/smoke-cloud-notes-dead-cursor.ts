/**
 * Cloud notes recovers from a dead change cursor instead of replaying it forever.
 *
 * Pins: when a watched drive's stored cursor has expired — OneDrive's `410 Gone`
 * (`resyncRequired`) for a delta token it no longer tracks, or Drive's `400 Invalid Value`
 * on `pageToken` — `listChanges` (src/lib/cloud-files.ts) throws `CloudCursorExpiredError`,
 * and `scanSource` (src/lib/cloud-notes/scan.ts) drops the cursor, takes a fresh one and
 * re-runs the 30-day look-back in the same pass. The dead cursor is sent once, never again,
 * and the drive is not parked as needing a reconnect.
 *
 * Why: every non-reauth failure used to be treated as transient — cursor kept, "Couldn’t
 * check this drive — will try again", retry in an hour with the same dead value — so a drive
 * whose token expired (the feature toggled off and on, a paused cron) was never scanned
 * again. Both providers' contract is "discard the token and start a fresh sync". Already-filed
 * docs are skipped by `cloud_note_files`, so the look-back does not duplicate them.
 *
 * Run: npx tsx scripts/smoke-cloud-notes-dead-cursor.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { cloudNoteSources } from "../src/db/schema";
import { scanSource, type ScanDeps } from "../src/lib/cloud-notes/scan";
import { NO_ENGINES } from "../src/lib/decisions/engine";
import type { CloudProvider } from "../src/lib/cloud-files";
import { checker } from "./smoke/check";
import { fakeUserId, purgeUsers } from "./smoke/factories";
import type { Call } from "./smoke/http-mock";

const t = checker();
const GRAPH = "https://graph.microsoft.com/v1.0";
const HOUR = 60 * 60_000;

type Case = {
  provider: CloudProvider;
  deadCursor: string;
  /** The provider's answer to the dead cursor, and to the fresh start the scan then makes. */
  answer: (url: string) => Response;
};

const CASES: Case[] = [
  {
    provider: "microsoft",
    deadCursor: `${GRAPH}/me/drive/root/delta?token=aTE09NjM4NzQ2expired`,
    answer: (url) => {
      if (url.includes("token=aTE09NjM4NzQ2expired"))
        return Response.json(
          { error: { code: "resyncRequired", message: "Resync required. Replace any local items with the server's version (including deletes) if you're sure that the service was up to date with your local changes when you last sync'd." } },
          { status: 410 }
        );
      if (url.includes("token=latest")) return Response.json({ "@odata.deltaLink": `${GRAPH}/me/drive/root/delta?token=fresh` });
      return Response.json({ value: [] });
    },
  },
  {
    provider: "google",
    deadCursor: "9876543",
    answer: (url) => {
      if (url.includes("pageToken=9876543"))
        return Response.json(
          { error: { code: 400, message: "Invalid Value", errors: [{ domain: "global", reason: "invalid", message: "Invalid Value", locationType: "parameter", location: "pageToken" }] } },
          { status: 400 }
        );
      if (url.includes("/changes/startPageToken")) return Response.json({ kind: "drive#startPageToken", startPageToken: "10000" });
      if (url.includes("/changes?")) return Response.json({ kind: "drive#changeList", newStartPageToken: "10001", changes: [] });
      return Response.json({ files: [] });
    },
  },
];

run(async () => {
  const db = await getDb();
  const users = CASES.map((c) => fakeUserId(`deadcursor_${c.provider}`));
  await purgeUsers(db, users);

  for (const [i, c] of CASES.entries()) {
    const userId = users[i];
    console.log(`\n${c.provider}: a watched drive whose stored change cursor has expired`);
    const t0 = new Date("2026-10-17T09:00:00Z");
    await db.insert(cloudNoteSources).values({
      userId,
      provider: c.provider,
      cursor: c.deadCursor,
      backfilledAt: new Date("2026-08-01T00:00:00Z"),
      lastScanAt: new Date("2026-08-01T00:00:00Z"),
      nextScanAt: t0,
    });

    const calls: Call[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push({ method: "GET", url, headers: {}, body: null });
      return c.answer(url);
    };
    const deps = (now: Date): ScanDeps => ({
      now,
      ctxFor: async () => ({ token: "test-cloud-token-not-real", fetchImpl }),
      engines: async () => NO_ENGINES,
      startRuns: async () => {},
    });
    const source = async () => (await db.query.cloudNoteSources.findFirst({ where: and(eq(cloudNoteSources.userId, userId), eq(cloudNoteSources.provider, c.provider)) }))!;

    // Three passes, an hour apart — what the cron does after each failure.
    const errors: string[] = [];
    for (let pass = 0; pass < 3; pass++) {
      try {
        await scanSource(userId, c.provider, deps(new Date(t0.getTime() + pass * HOUR)));
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    const row = await source();
    const deadAsks = calls.filter((call) => call.url.includes(c.provider === "microsoft" ? "expired" : "pageToken=9876543")).length;

    t.check("the provider answered the dead cursor as expired/invalid", deadAsks >= 1, `${deadAsks} request(s)`);
    // An expired cursor is the provider's lifecycle, not a dead grant.
    t.check("the drive is not parked as needing a reconnect", row.lastError === null || !/reconnect/i.test(row.lastError), String(row.lastError));
    t.check(
      `${c.provider} — the dead change cursor is dropped, not replayed on every pass`,
      row.cursor !== c.deadCursor && deadAsks <= 1,
      `cursor=${row.cursor} after 3 passes; dead cursor sent ${deadAsks}×; errors: ${errors.join(" | ")}`
    );
    t.check(
      `${c.provider} — the drive recovers (a fresh cursor and a new look-back)`,
      row.lastError === null || errors.length < 3,
      `${errors.length}/3 passes failed; nextScanAt=${row.nextScanAt.toISOString()}`
    );
  }

  await purgeUsers(db, users);
  t.done("cloud notes dead cursor");
});
