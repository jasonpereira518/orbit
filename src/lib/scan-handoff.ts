/**
 * The grant that lets a phone which has never signed in contribute one scan.
 *
 * ## The problem
 *
 * Scanning is a phone job — the camera is there, and the notebook is next to it — but
 * Orbit is open on a laptop and signing into a CRM on a phone keyboard, at exactly the
 * moment someone wants to point a camera at something, is the friction the feature exists
 * to remove. So the desktop mints a grant, renders it as a QR code, and the phone redeems
 * it without ever authenticating.
 *
 * ## Why a row and not a signed token
 *
 * A stateless JWT would carry the grant with no storage. It cannot carry anything BACK,
 * and this handoff is a round trip: the phone produces a transcript, and the desktop has
 * to notice it arrive. Once a row has to exist for the result to land in, storing the
 * hash alongside it is free, and buys single-use redemption and instant revocation.
 *
 * ## What is stored
 *
 * Text, never pixels. The photos are transcribed inside the request that carries them and
 * are dropped when it ends — routing capture through a phone must not quietly promote
 * ephemeral media into stored user imagery. See `capture-ingest.ts`.
 *
 * ## Shape
 *
 *   orb_scan_7f3a9c2b_<43 base64url characters>
 *
 * Deliberately the same shape as `src/lib/api/keys.ts`, including the cheap regex that
 * runs before any query, so a flood of malformed tokens against a public route costs
 * zero database work. Hashed, not encrypted, for the reasons set out in that file.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { captureHandoffs, captureJobs, userSettings } from "@/db/schema";
import { getAppBaseUrl } from "@/lib/app-url";
import { appendIngestedBlocks, createCaptureJob, discardCaptureJobRow, markCaptureJobTranscribed } from "@/lib/capture-jobs";

const SCAN_PREFIX = "orb_scan";

/** Shape check only — cheap enough to reject a malformed token before touching the DB. */
const SCAN_TOKEN_SHAPE = /^orb_scan_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/;

/**
 * How long a QR code is worth scanning.
 *
 * Long enough to find your phone, unlock it and open the camera; short enough that a photo
 * of someone's screen taken across a table is worthless by the time it is acted on. The
 * countdown is shown, so an expiry is never a surprise — and re-minting is one click.
 */
export const HANDOFF_TTL_MS = 10 * 60 * 1000;

export type GeneratedHandoffToken = { token: string; tokenHash: string };

export function generateHandoffToken(): GeneratedHandoffToken {
  const publicPart = randomBytes(4).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const token = `${SCAN_PREFIX}_${publicPart}_${secret}`;
  return { token, tokenHash: hashHandoffToken(token) };
}

export function hashHandoffToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Whether a string could possibly be one of our handoff tokens. A shape test and nothing
 * more — passing says nothing about whether the grant exists or is still live.
 */
export function looksLikeHandoffToken(token: string | null | undefined): boolean {
  return typeof token === "string" && SCAN_TOKEN_SHAPE.test(token);
}

/** The URL the QR code encodes. */
export function buildScanHandoffUrl(token: string): string {
  return `${getAppBaseUrl()}/scan/${token}`;
}

export type HandoffStatus = "pending" | "uploading" | "ready" | "claimed";

export type ScanHandoff = {
  id: string;
  userId: string;
  status: HandoffStatus;
  transcript: string | null;
  pageCount: number;
  sources: string | null;
  error: string | null;
  expiresAt: Date;
  captureJobId: string | null;
};

/**
 * Delete grants that are past their expiry.
 *
 * Called opportunistically when minting rather than on a cron: the table only ever grows
 * when someone starts a scan, so the act of starting one is exactly when it is worth
 * tidying, and it keeps this feature from needing a scheduled job of its own.
 */
export async function sweepExpiredHandoffs(): Promise<void> {
  const db = await getDb();
  await db.delete(captureHandoffs).where(lt(captureHandoffs.expiresAt, new Date()));
}

export type MintedHandoff = { token: string; url: string; expiresAt: Date; captureJobId: string };

/**
 * Mint a grant. It is born attached to a capture job (`ingesting`): every batch of pages
 * the phone sends is transcribed and appended to that job, and the desktop watches the
 * job rather than this row — so a second send is an append, not a 404, and the text is
 * already where extraction will read it from.
 */
export async function mintScanHandoff(userId: string): Promise<MintedHandoff> {
  await sweepExpiredHandoffs().catch(() => {
    // Tidying is not the caller's job. A full table is a problem for later; a person
    // waiting on a QR code is a problem now.
  });

  const { token, tokenHash } = generateHandoffToken();
  const expiresAt = new Date(Date.now() + HANDOFF_TTL_MS);

  const job = await createCaptureJob(userId, { sourceKind: "phone", status: "ingesting" });
  const db = await getDb();
  await db.insert(captureHandoffs).values({ userId, tokenHash, expiresAt, captureJobId: job.id });

  return { token, url: buildScanHandoffUrl(token), expiresAt, captureJobId: job.id };
}

/**
 * Resolve a raw token to its live grant, or null.
 *
 * Null — never a throw, and never a distinct "expired" answer — so every caller can answer with
 * the same flat 404. A 401 would confirm that the endpoint gates by token, and some
 * clients respond to one by prompting for credentials the holder does not have.
 */
export async function findScanHandoff(rawToken: string): Promise<ScanHandoff | null> {
  if (!looksLikeHandoffToken(rawToken)) return null;

  const db = await getDb();
  const row = await db.query.captureHandoffs.findFirst({
    where: eq(captureHandoffs.tokenHash, hashHandoffToken(rawToken)),
  });
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;

  // This path is authenticated by the token alone and never calls `requireUserId()`, so
  // the suspension gate there does not cover it. Same reasoning as the calendar feed.
  const owner = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, row.userId),
    columns: { suspendedAt: true },
  });
  if (owner?.suspendedAt) return null;

  return {
    id: row.id,
    userId: row.userId,
    status: row.status,
    transcript: row.transcript,
    pageCount: row.pageCount,
    sources: row.sources,
    error: row.error,
    expiresAt: row.expiresAt,
    captureJobId: row.captureJobId,
  };
}

/** The phone has started uploading — shown on the desktop as "Phone connected". */
export async function markHandoffUploading(id: string): Promise<void> {
  const db = await getDb();
  await db
    .update(captureHandoffs)
    .set({ status: "uploading", updatedAt: new Date() })
    .where(and(eq(captureHandoffs.id, id), eq(captureHandoffs.status, "pending")));
}

/**
 * One batch of pages, transcribed: appended to the grant's capture job as a block, and
 * counted on the row. The grant stays redeemable so the phone can send more; the text
 * lives on the job, never here.
 */
export async function recordHandoffTranscript(
  id: string,
  result: { transcript: string; pageCount: number; sources: string; photoIds?: string[] }
): Promise<void> {
  const db = await getDb();
  const row = await db.query.captureHandoffs.findFirst({ where: eq(captureHandoffs.id, id) });
  if (row?.captureJobId && (result.transcript.trim() || result.photoIds?.length)) {
    await appendIngestedBlocks(
      row.captureJobId,
      result.transcript.trim() ? [{ text: result.transcript.trim(), source: result.sources }] : [],
      { sources: [result.sources], photoIds: result.photoIds ?? [] }
    );
  }
  await db
    .update(captureHandoffs)
    .set({
      status: "ready",
      pageCount: (row?.pageCount ?? 0) + result.pageCount,
      sources: result.sources,
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(captureHandoffs.id, id));
}

/**
 * The phone (or the desktop) says it is done: the grant is consumed and the job moves to
 * `transcribed`, where the desktop shows the text and offers Extract. Idempotent.
 */
export async function finishScanHandoff(id: string): Promise<{ captureJobId: string | null }> {
  const db = await getDb();
  const row = await db.query.captureHandoffs.findFirst({ where: eq(captureHandoffs.id, id) });
  if (!row) return { captureJobId: null };
  await db.delete(captureHandoffs).where(eq(captureHandoffs.id, row.id));
  if (row.captureJobId) await markCaptureJobTranscribed(row.captureJobId);
  return { captureJobId: row.captureJobId };
}

/**
 * Record a failure the phone should see, and the desktop should stop waiting for.
 *
 * The grant is left redeemable: the usual cause is one bad photo, and making the person
 * walk back to their laptop for a fresh QR code to retake it would be a poor trade.
 */
export async function recordHandoffError(id: string, message: string): Promise<void> {
  const db = await getDb();
  await db
    .update(captureHandoffs)
    .set({ status: "pending", error: message, updatedAt: new Date() })
    .where(eq(captureHandoffs.id, id));
}

/** Drop a grant the desktop has given up on, so a stale QR cannot be redeemed later. */
export async function cancelScanHandoff(userId: string, rawToken: string): Promise<void> {
  if (!looksLikeHandoffToken(rawToken)) return;
  const db = await getDb();
  const rows = await db
    .delete(captureHandoffs)
    .where(
      and(
        eq(captureHandoffs.tokenHash, hashHandoffToken(rawToken)),
        eq(captureHandoffs.userId, userId)
      )
    )
    .returning();
  // The job it was feeding goes too, unless the phone already sent something worth keeping.
  for (const row of rows) {
    if (row.captureJobId) await discardEmptyCaptureJob(userId, row.captureJobId);
  }
}

/** A `phone` job that never received a page is noise; one with text is left `transcribed`. */
async function discardEmptyCaptureJob(userId: string, id: string): Promise<void> {
  const db = await getDb();
  const job = await db.query.captureJobs.findFirst({ where: and(eq(captureJobs.id, id), eq(captureJobs.userId, userId)) });
  if (!job || job.status !== "ingesting") return;
  if ((job.ingestedBlocks ?? []).length) {
    await markCaptureJobTranscribed(id);
    return;
  }
  await discardCaptureJobRow(userId, id);
}

/** For the desktop: which job a live grant feeds, scoped to the minting account. */
export async function handoffJobFor(userId: string, rawToken: string): Promise<{ captureJobId: string | null; status: HandoffStatus; error: string | null } | null> {
  if (!looksLikeHandoffToken(rawToken)) return null;
  const db = await getDb();
  const row = await db.query.captureHandoffs.findFirst({
    where: and(eq(captureHandoffs.tokenHash, hashHandoffToken(rawToken)), eq(captureHandoffs.userId, userId)),
  });
  if (!row || row.expiresAt.getTime() <= Date.now()) return null;
  return { captureJobId: row.captureJobId, status: row.status, error: row.error };
}
