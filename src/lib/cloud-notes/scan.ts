import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { cloudNoteFiles, cloudNoteSources, userSettings } from "@/db/schema";
import {
  cloudAccessToken,
  listChanges,
  listRecentFiles,
  readFileText,
  startChangeCursor,
  type CloudCtx,
  type CloudFile,
  type CloudProvider,
} from "@/lib/cloud-files";
import { classifyNoteDoc, HEAD_CHARS, type NoteVerdict } from "@/lib/cloud-notes/detect";
import { extractCloudFiles, startCaptureRuns } from "@/lib/cloud-notes/extract";
import { openEngines, type Engines } from "@/lib/decisions/engine";
import { decideNoteDocs } from "@/lib/decisions/notes";
import { ReauthRequiredError } from "@/lib/errors";
import { triageName } from "@/lib/imports/drive-triage";

/**
 * The cloud-notes pass: for each watched drive that is due, read what changed since last time,
 * keep the docs that look like meeting notes as `found` rows, and — when the person turned on
 * auto-extract — queue the new ones as capture jobs to review.
 *
 * The first pass on a drive looks back 30 days (`from_backfill`). Auto-extract never runs on
 * that backlog: the person is offered it once, as one prompt.
 */

export const SCAN_EVERY_MS = 30 * 60_000;
export const BACKFILL_DAYS = 30;
/** Docs whose first lines are read per drive per pass. */
export const MAX_READS = 25;
/** Change pages followed per drive per pass (25 changes each). */
const MAX_CHANGE_PAGES = 4;
/**
 * New docs auto-extracted per drive per pass — each is a full capture parse on the person's
 * AI. ponytail: a flat cap, not the managed pool's background floor; if auto-extract spend
 * shows up in the credit reports, give capture's parse a background twin and route these through it.
 */
export const MAX_AUTO_EXTRACT = 5;
const LEASE_MS = 4 * 60_000;
const RETRY_AFTER_ERROR_MS = 60 * 60_000;
const RETRY_AFTER_REAUTH_MS = 24 * 60 * 60_000;

export type ScanDeps = {
  now?: Date;
  /** The provider context — injectable so the smoke drives canned responses. */
  ctxFor?: (userId: string, provider: CloudProvider) => Promise<CloudCtx>;
  engines?: (userId: string) => Promise<Engines>;
  /** Start the queued capture jobs. Defaults to kicking the internal run route. */
  startRuns?: (jobIds: string[]) => Promise<void>;
};

export type SourceScanResult = { found: number; autoExtracted: number; read: number };

type Candidate = { file: CloudFile; verdict: NoteVerdict; head: string };

async function defaultCtx(userId: string, provider: CloudProvider): Promise<CloudCtx> {
  return { token: await cloudAccessToken(userId, provider) };
}

/** Scan one drive now. Throws only on a database failure; a provider failure is recorded on the source. */
export async function scanSource(userId: string, provider: CloudProvider, deps: ScanDeps = {}): Promise<SourceScanResult> {
  const now = deps.now ?? new Date();
  const db = await getDb();
  const source = await db.query.cloudNoteSources.findFirst({
    where: and(eq(cloudNoteSources.userId, userId), eq(cloudNoteSources.provider, provider)),
  });
  if (!source) return { found: 0, autoExtracted: 0, read: 0 };

  try {
    const ctx = await (deps.ctxFor ?? defaultCtx)(userId, provider);

    // 1. What to look at: the last 30 days on the first pass, the changes since the cursor after.
    let files: CloudFile[];
    let cursor: string;
    const fromBackfill = !source.backfilledAt;
    if (fromBackfill) {
      // The "from now on" cursor first, so nothing edited during the look-back is missed.
      cursor = source.cursor ?? (await startChangeCursor(ctx, provider));
      const since = new Date(now.getTime() - BACKFILL_DAYS * 24 * 60 * 60_000);
      files = (await listRecentFiles(ctx, provider, { since, pageSize: 50 })).files;
    } else {
      cursor = source.cursor ?? (await startChangeCursor(ctx, provider));
      files = [];
      for (let page = 0; page < MAX_CHANGE_PAGES; page++) {
        const res = await listChanges(ctx, provider, cursor);
        files.push(...res.files);
        cursor = res.cursor;
        if (res.done) break;
      }
    }

    // 2. Only docs Orbit has never filed — found, extracted and dismissed all stay put.
    const byId = new Map(files.map((f) => [f.id, f]));
    const ids = [...byId.keys()];
    const known = ids.length
      ? await db
          .select({ fileId: cloudNoteFiles.fileId })
          .from(cloudNoteFiles)
          .where(and(eq(cloudNoteFiles.userId, userId), eq(cloudNoteFiles.provider, provider), inArray(cloudNoteFiles.fileId, ids)))
      : [];
    const knownIds = new Set(known.map((k) => k.fileId));
    const fresh = [...byId.values()]
      .filter((f) => !knownIds.has(f.id))
      .sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));

    // 3. Classify. A name that rules the doc out is never opened; past the read cap, only a
    //    name that says notes is kept (ponytail: the rest of a huge change burst is dropped,
    //    not queued — raise MAX_READS if real drives hit it).
    const candidates: Candidate[] = [];
    let read = 0;
    for (const file of fresh) {
      const name = triageName(file.name);
      if (name.verdict === "no" && name.why !== "The name gives nothing to go on") continue;
      if (read >= MAX_READS) {
        if (name.verdict === "yes") candidates.push({ file, verdict: { verdict: "yes", reason: name.why }, head: "" });
        continue;
      }
      read++;
      let head: string;
      try {
        head = (await readFileText(ctx, provider, file)).slice(0, HEAD_CHARS);
      } catch (err) {
        if (err instanceof ReauthRequiredError) throw err;
        continue; // gone, too big, or unreadable: not notes Orbit can extract anyway
      }
      const verdict = classifyNoteDoc({ name: file.name, head });
      if (verdict.verdict !== "no") candidates.push({ file, verdict, head });
    }

    // 4. The maybes go to the decision engine; without one, the rules' fallback stands.
    const maybes = candidates.filter((c) => c.verdict.verdict === "maybe");
    const decidedBy = new Map<string, "rules" | "decision">();
    let keep = candidates.filter((c) => c.verdict.verdict === "yes");
    if (maybes.length) {
      const engines = await (deps.engines ?? ((id: string) => openEngines(id, { llm: true })))(userId);
      const answers = await decideNoteDocs(engines, maybes.map((m) => ({ name: m.file.name, head: m.head })));
      maybes.forEach((m, i) => {
        const a = answers[i];
        const offer = a?.offer ?? m.verdict.offerWithoutEngine === true;
        if (!offer) return;
        if (a && a.offer !== null) decidedBy.set(m.file.id, "decision");
        keep = [...keep, m];
      });
    }

    // 5. File them.
    const inserted = keep.length
      ? await db
          .insert(cloudNoteFiles)
          .values(
            keep.map((c) => ({
              userId,
              provider,
              fileId: c.file.id,
              name: c.file.name.slice(0, 300),
              webUrl: c.file.webUrl,
              modifiedAt: new Date(c.file.modifiedTime),
              status: "found" as const,
              reason: c.verdict.reason,
              detectedBy: decidedBy.get(c.file.id) ?? ("rules" as const),
              fromBackfill: fromBackfill ? 1 : 0,
            })),
          )
          .onConflictDoNothing()
          .returning()
      : [];

    // 6. Auto-extract the new ones, never the backlog.
    let autoExtracted = 0;
    if (!fromBackfill && inserted.length) {
      const settings = await db.query.userSettings.findFirst({
        where: eq(userSettings.userId, userId),
        columns: { cloudNotesAutoExtract: true },
      });
      if (settings?.cloudNotesAutoExtract === 1) {
        const insertedIds = new Set(inserted.map((r) => r.fileId));
        const picks = keep.filter((c) => insertedIds.has(c.file.id)).slice(0, MAX_AUTO_EXTRACT).map((c) => c.file);
        const result = await extractCloudFiles(userId, { provider, files: picks, batchGroupId: crypto.randomUUID() }, { ctx }).catch(() => null);
        if (result) {
          autoExtracted = result.queued.length;
          if (result.queued.length) await (deps.startRuns ?? startCaptureRuns)(result.queued.map((q) => q.jobId));
        }
      }
    }

    await db
      .update(cloudNoteSources)
      .set({
        cursor,
        backfilledAt: source.backfilledAt ?? now,
        lastScanAt: now,
        nextScanAt: new Date(now.getTime() + SCAN_EVERY_MS),
        leaseUntil: null,
        lastError: null,
      })
      .where(and(eq(cloudNoteSources.userId, userId), eq(cloudNoteSources.provider, provider)));
    return { found: inserted.length, autoExtracted, read };
  } catch (err) {
    const reauth = err instanceof ReauthRequiredError;
    await db
      .update(cloudNoteSources)
      .set({
        leaseUntil: null,
        lastError: reauth ? err.message : "Couldn’t check this drive — will try again",
        nextScanAt: new Date(now.getTime() + (reauth ? RETRY_AFTER_REAUTH_MS : RETRY_AFTER_ERROR_MS)),
      })
      .where(and(eq(cloudNoteSources.userId, userId), eq(cloudNoteSources.provider, provider)));
    if (reauth) return { found: 0, autoExtracted: 0, read: 0 };
    throw err;
  }
}

/** Claim due drives — the lease stops two overlapping cron runs scanning one drive twice. */
export async function claimDueSources(limit: number, now: Date): Promise<Array<{ userId: string; provider: CloudProvider }>> {
  const db = await getDb();
  const lease = new Date(now.getTime() + LEASE_MS);
  const rows = rowsOf<{ user_id: string; provider: CloudProvider }>(
    await db.execute(sql`
      UPDATE cloud_note_sources SET lease_until = ${lease}
       WHERE (user_id, provider) IN (
         SELECT user_id, provider FROM cloud_note_sources
          WHERE next_scan_at <= ${now}
            AND (lease_until IS NULL OR lease_until < ${now})
          ORDER BY next_scan_at
          LIMIT ${limit})
      RETURNING user_id, provider
    `),
  );
  return rows.map((r) => ({ userId: r.user_id, provider: r.provider }));
}

export type CloudNotesPassStats = { claimed: number; scanned: number; failed: number; found: number; autoExtracted: number; budgetExhausted: boolean; claimFull: boolean };

const CLAIM_LIMIT = 20;
const PASS_BUDGET_MS = 240_000;

/** The cron pass: claim due drives in batches until none are due or the budget is spent. */
export async function runCloudNotesPass(deps: ScanDeps = {}): Promise<CloudNotesPassStats> {
  const started = Date.now();
  const stats: CloudNotesPassStats = { claimed: 0, scanned: 0, failed: 0, found: 0, autoExtracted: 0, budgetExhausted: false, claimFull: false };
  while (true) {
    if (Date.now() - started > PASS_BUDGET_MS) {
      stats.budgetExhausted = true;
      break;
    }
    const claimed = await claimDueSources(CLAIM_LIMIT, deps.now ?? new Date());
    stats.claimed += claimed.length;
    stats.claimFull = claimed.length === CLAIM_LIMIT;
    if (claimed.length === 0) break;
    // Four drives at a time: each is mostly waiting on its provider.
    const queue = [...claimed];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          try {
            const r = await scanSource(next.userId, next.provider, deps);
            stats.scanned++;
            stats.found += r.found;
            stats.autoExtracted += r.autoExtracted;
          } catch {
            stats.failed++;
          }
        }
      }),
    );
    if (!stats.claimFull) break;
  }
  return stats;
}

/** "Check now": every drive this person has, due or not. */
export async function scanCloudNotesForUser(userId: string, deps: ScanDeps = {}): Promise<{ found: number }> {
  const db = await getDb();
  const sources = await db
    .select({ provider: cloudNoteSources.provider })
    .from(cloudNoteSources)
    .where(eq(cloudNoteSources.userId, userId));
  let found = 0;
  for (const { provider } of sources) found += (await scanSource(userId, provider, deps)).found;
  return { found };
}
