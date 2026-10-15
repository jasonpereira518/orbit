"use server";

/**
 * Cloud notes: the /capture Drive & OneDrive tab, the review dialog, the toast and the
 * auto-extract switch. Every action is closed until the `feature.cloud-notes` surface is
 * released — a Server Function answers a direct POST whether or not the tab is shown.
 */
import { after } from "next/server";
import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { cloudNoteFiles, cloudNoteSources, gmailConnections, outlookConnections, userSettings } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { cloudAccessToken, isCloudProvider, listRecentFiles, type CloudFile, type CloudProvider } from "@/lib/cloud-files";
import { cloudReadError, extractCloudFiles, startCaptureRuns, type CloudExtractResult } from "@/lib/cloud-notes/extract";
import { OPEN_RESCAN_MS, scanCloudNotesForUser, scanStaleCloudNotesForUser } from "@/lib/cloud-notes/scan";
import { grantCoversCloudNotes } from "@/lib/cloud-notes/sources";
import { isDemoWorkspace } from "@/lib/demo-workspace";
import { asActionResult, UserFacingError, type ActionResult } from "@/lib/errors";
import { requireSyncUser } from "@/lib/plan-guards";
import { RATE_LIMITS, consumeBucket } from "@/lib/rate-limit";
import { CLOUD_NOTES_SURFACE_KEY } from "@/lib/surfaces";
import { isSurfaceLive, requireReleasedSurface } from "@/lib/surface-visibility";
import { getEntitlements } from "@/lib/entitlements";

export type CloudDriveState = {
  provider: CloudProvider;
  /** A Google/Microsoft account is connected at all. */
  connected: boolean;
  /** The connection holds the read scope cloud notes needs. */
  granted: boolean;
  lastScanAt: string | null;
  lastError: string | null;
};

export type FoundCloudNote = {
  id: string;
  provider: CloudProvider;
  fileId: string;
  name: string;
  webUrl: string | null;
  modifiedAt: string | null;
  reason: string | null;
  fromBackfill: boolean;
};

export type CloudNotesState = {
  drives: CloudDriveState[];
  autoExtract: boolean;
  found: FoundCloudNote[];
};

export type PickerFile = CloudFile & { status: "found" | "queued" | "dismissed" | null; reason: string | null };

const MAX_EXTRACT = 25;
const FILE_ID = /^[A-Za-z0-9!_.-]{5,200}$/;
const BATCH_ID = /^[\w-]{8,64}$/;
const ROW_ID = /^[0-9a-f-]{36}$/i;

async function requireCloudNotesUser(): Promise<string> {
  const userId = await requireSyncUser();
  await requireReleasedSurface(userId, CLOUD_NOTES_SURFACE_KEY);
  return userId;
}

function parseProvider(value: unknown): CloudProvider {
  if (!isCloudProvider(value)) throw new UserFacingError("Pick Google Drive or OneDrive");
  return value;
}

function cleanRowIds(ids: unknown): string[] {
  return (Array.isArray(ids) ? ids : []).filter((id): id is string => typeof id === "string" && ROW_ID.test(id)).slice(0, 200);
}

/** Docs found by the scan and still waiting, newest first. Shared by the tab, the dialog and the toast. */
async function loadFound(userId: string, limit = 50): Promise<FoundCloudNote[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(cloudNoteFiles)
    .where(and(eq(cloudNoteFiles.userId, userId), eq(cloudNoteFiles.status, "found")))
    .orderBy(desc(cloudNoteFiles.modifiedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    fileId: r.fileId,
    name: r.name,
    webUrl: r.webUrl,
    modifiedAt: r.modifiedAt?.toISOString() ?? null,
    reason: r.reason,
    fromBackfill: r.fromBackfill === 1,
  }));
}

export async function getCloudNotesState(): Promise<CloudNotesState> {
  const userId = await requireCloudNotesUser();
  const db = await getDb();
  const [google, microsoft, sources, settings, found] = await Promise.all([
    db.query.gmailConnections.findFirst({ where: eq(gmailConnections.userId, userId), columns: { scopes: true, status: true } }),
    db.query.outlookConnections.findFirst({ where: eq(outlookConnections.userId, userId), columns: { scopes: true, status: true } }),
    db.select().from(cloudNoteSources).where(eq(cloudNoteSources.userId, userId)),
    db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId), columns: { cloudNotesAutoExtract: true } }),
    loadFound(userId),
  ]);
  const drive = (provider: CloudProvider, conn: { scopes: string | null; status: string } | undefined): CloudDriveState => {
    const source = sources.find((s) => s.provider === provider);
    return {
      provider,
      connected: Boolean(conn),
      granted: Boolean(conn && conn.status === "active" && grantCoversCloudNotes(provider, conn.scopes)),
      lastScanAt: source?.lastScanAt?.toISOString() ?? null,
      lastError: source?.lastError ?? null,
    };
  };
  return {
    drives: [drive("google", google), drive("microsoft", microsoft)],
    autoExtract: settings?.cloudNotesAutoExtract === 1,
    found,
  };
}

/** One page of the picker: recent docs, or docs whose name matches `query`. */
export async function listCloudNoteFiles(input: {
  provider: CloudProvider;
  query?: string;
  pageToken?: string | null;
}): Promise<ActionResult<{ files: PickerFile[]; next: string | null }>> {
  const userId = await requireCloudNotesUser();
  return asActionResult(async () => {
    const provider = parseProvider(input.provider);
    if (await isDemoWorkspace(userId)) return { files: [], next: null };
    const query = typeof input.query === "string" ? input.query.slice(0, 100) : undefined;
    const pageToken = typeof input.pageToken === "string" ? input.pageToken.slice(0, 2000) : null;
    let page: Awaited<ReturnType<typeof listRecentFiles>>;
    try {
      page = await listRecentFiles({ token: await cloudAccessToken(userId, provider) }, provider, { query, pageToken });
    } catch (err) {
      throw cloudReadError(err, provider);
    }
    const db = await getDb();
    const known = page.files.length
      ? await db
          .select({ fileId: cloudNoteFiles.fileId, status: cloudNoteFiles.status, reason: cloudNoteFiles.reason })
          .from(cloudNoteFiles)
          .where(
            and(
              eq(cloudNoteFiles.userId, userId),
              eq(cloudNoteFiles.provider, provider),
              inArray(cloudNoteFiles.fileId, page.files.map((f) => f.id)),
            ),
          )
      : [];
    const byId = new Map(known.map((k) => [k.fileId, k]));
    return {
      files: page.files.map((f) => ({ ...f, status: byId.get(f.id)?.status ?? null, reason: byId.get(f.id)?.reason ?? null })),
      next: page.next,
    };
  });
}

/**
 * Read the picked docs and queue each as a capture job under one batch, to review on /capture.
 * Nothing reaches contacts until the person accepts the cards.
 */
export async function extractCloudNotes(input: {
  provider: CloudProvider;
  files: { id: string; name: string; webUrl?: string | null; modifiedTime?: string | null }[];
  batchGroupId: string;
}): Promise<ActionResult<CloudExtractResult>> {
  const userId = await requireCloudNotesUser();
  return asActionResult(async () => {
    const provider = parseProvider(input.provider);
    if (typeof input.batchGroupId !== "string" || !BATCH_ID.test(input.batchGroupId)) {
      throw new UserFacingError("Couldn’t start that — try again");
    }
    // Browser-supplied: ids go into a provider URL, names onto the job.
    const files = (Array.isArray(input.files) ? input.files : [])
      .filter((f) => typeof f?.id === "string" && FILE_ID.test(f.id) && typeof f.name === "string" && f.name.trim())
      .map((f) => ({
        id: f.id,
        name: f.name.slice(0, 300),
        webUrl: typeof f.webUrl === "string" && f.webUrl.startsWith("https://") ? f.webUrl.slice(0, 2000) : null,
        modifiedTime: typeof f.modifiedTime === "string" && !Number.isNaN(Date.parse(f.modifiedTime)) ? f.modifiedTime : undefined,
      }));
    if (files.length === 0) throw new UserFacingError("Pick at least one doc");
    if (files.length > MAX_EXTRACT) throw new UserFacingError(`Pick up to ${MAX_EXTRACT} docs at a time`);
    if (await isDemoWorkspace(userId)) throw new UserFacingError("Drives aren’t connected in the demo workspace");
    await consumeBucket("capture", userId, RATE_LIMITS.capture);

    const result = await extractCloudFiles(userId, { provider, files, batchGroupId: input.batchGroupId });
    const jobIds = result.queued.map((q) => q.jobId);
    if (jobIds.length) after(() => startCaptureRuns(jobIds));
    revalidatePath("/capture");
    return result;
  });
}

/** Scan this person's drives now instead of waiting for the next pass. */
export async function checkCloudNotesNow(): Promise<ActionResult<{ found: number }>> {
  const userId = await requireCloudNotesUser();
  return asActionResult(async () => {
    if (await isDemoWorkspace(userId)) return { found: 0 };
    await consumeBucket("capture", userId, RATE_LIMITS.capture);
    return scanCloudNotesForUser(userId);
  });
}

/**
 * Called by the app shell when the app opens or its tab comes back into view. Scans, in the
 * background, any drive that went an hour or more without a scan (the 30-minute cron is a
 * floor, not a promise: GitHub's scheduler lags and pauses). Quiet for anyone the feature is
 * not live for — every account's shell calls it. `started` says whether a scan was kicked, so
 * the caller knows to refresh the pulse once it has had time to finish.
 */
export async function scanCloudNotesOnOpen(): Promise<{ started: boolean }> {
  const userId = await requireUserId();
  if (!(await isSurfaceLive(userId, CLOUD_NOTES_SURFACE_KEY))) return { started: false };
  if (!(await getEntitlements(userId)).canUseSync || (await isDemoWorkspace(userId))) return { started: false };
  const db = await getDb();
  const [stale] = await db
    .select({ provider: cloudNoteSources.provider })
    .from(cloudNoteSources)
    .where(
      and(
        eq(cloudNoteSources.userId, userId),
        or(isNull(cloudNoteSources.lastScanAt), lte(cloudNoteSources.lastScanAt, new Date(Date.now() - OPEN_RESCAN_MS))),
      ),
    )
    .limit(1);
  if (!stale) return { started: false };
  // After the response: a Server Action holds its tab's action lane until it returns, and a
  // drive scan reads up to 25 docs.
  after(() => scanStaleCloudNotesForUser(userId).catch(() => null));
  return { started: true };
}

/** Never offer these docs again. */
export async function dismissCloudNotes(ids: string[]): Promise<ActionResult<{ dismissed: number }>> {
  const userId = await requireCloudNotesUser();
  return asActionResult(async () => {
    const clean = cleanRowIds(ids);
    if (clean.length === 0) return { dismissed: 0 };
    const db = await getDb();
    const rows = await db
      .update(cloudNoteFiles)
      .set({ status: "dismissed", updatedAt: sql`now()` })
      .where(and(eq(cloudNoteFiles.userId, userId), inArray(cloudNoteFiles.id, clean), eq(cloudNoteFiles.status, "found")))
      .returning();
    return { dismissed: rows.length };
  });
}

/** The toast fired for these; stamp them so no other device toasts them again. */
export async function markCloudNotesNotified(ids: string[]): Promise<void> {
  const userId = await requireUserId();
  const clean = cleanRowIds(ids);
  if (clean.length === 0) return;
  const db = await getDb();
  await db
    .update(cloudNoteFiles)
    .set({ notifiedAt: sql`now()` })
    .where(and(eq(cloudNoteFiles.userId, userId), inArray(cloudNoteFiles.id, clean), isNull(cloudNoteFiles.notifiedAt)));
}

export async function getFoundCloudNotes(): Promise<FoundCloudNote[]> {
  const userId = await requireCloudNotesUser();
  return loadFound(userId);
}

export async function saveCloudNotesAutoExtract(enabled: boolean): Promise<ActionResult<{ enabled: boolean }>> {
  const userId = await requireCloudNotesUser();
  return asActionResult(async () => {
    const value = enabled === true ? 1 : 0;
    const db = await getDb();
    await db
      .insert(userSettings)
      .values({ userId, cloudNotesAutoExtract: value })
      .onConflictDoUpdate({ target: userSettings.userId, set: { cloudNotesAutoExtract: value } });
    revalidatePath("/settings");
    revalidatePath("/capture");
    return { enabled: value === 1 };
  });
}
