import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import type { EmailAttachmentRef, EmailProviderId } from "@/db/schema";
import * as blob from "@/lib/blob-lazy";
import {
  ATTACHMENT_PREFIX,
  attachmentPrefixFor,
  BLOB_ACCESS,
  isBlockedFilename,
  safeFilename,
} from "@/lib/email/attachment-paths";
import {
  ATTACHMENT_RETENTION_MS,
  MAX_ATTACHMENTS,
  maxAttachmentBytesFor,
  ORPHAN_UPLOAD_TTL_MS,
} from "@/lib/email/config";
import { MailProviderError } from "@/lib/email/providers/types";
import { reportError } from "@/lib/report-error";

export { ATTACHMENT_PREFIX, attachmentPrefixFor, BLOB_ACCESS, isBlockedFilename, safeFilename } from "@/lib/email/attachment-paths";

/**
 * Email attachments (direct-email P4). The browser uploads straight to Vercel Blob under
 * `email-attachments/<userId>/…` (token route: src/app/api/email/attachments/upload); the
 * composer then sends only pathnames. Nothing about a file is trusted from the client: the owner
 * comes from the path prefix, and size and type from Blob's own `head()`.
 *
 * SDK facts this relies on (@vercel/blob 2.8, checked Sep 30 2026): `head(pathname)` returns
 * `{ size, contentType, pathname, url, uploadedAt }`; `get(pathname, { access })` returns
 * `{ statusCode: 200, stream }` or null when missing; `list({ prefix, cursor, limit })` pages;
 * the client-upload token route cannot set access — the uploading client does.
 */

export type BlobClient = {
  head(p: string): Promise<{ pathname: string; url: string; size: number; contentType: string }>;
  get(p: string): Promise<{ bytes: Uint8Array } | null>;
  del(p: string | string[]): Promise<void>;
  list(opts: { prefix: string; cursor?: string; limit?: number }): Promise<{
    blobs: { pathname: string; url: string; uploadedAt: Date }[];
    hasMore: boolean;
    cursor?: string;
  }>;
};

const realClient: BlobClient = {
  async head(p) {
    return blob.head(p);
  },
  async get(p) {
    const res = await blob.get(p, { access: BLOB_ACCESS });
    if (!res || res.statusCode !== 200 || !res.stream) return null;
    return { bytes: new Uint8Array(await new Response(res.stream).arrayBuffer()) };
  },
  async del(p) {
    await blob.del(p);
  },
  async list(opts) {
    return blob.list(opts);
  },
};

let client: BlobClient = realClient;
/** Smoke tests only. */
export function setAttachmentBlobClientForTests(c: BlobClient | null) {
  client = c ?? realClient;
}
export function attachmentBlobClient(): BlobClient {
  return client;
}

export type AttachmentInput = { pathname: string; filename: string };
export type AttachmentFailure = {
  ok: false;
  reason: "too_many" | "too_large" | "blocked_type" | "not_found";
  message: string;
};

function mb(bytes: number) {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

const NOT_AVAILABLE = "One of those files isn’t available — attach it again";

/** Ownership, real sizes and the mailbox's limit, checked before a row is queued. */
export async function verifyAttachmentRefs(
  userId: string,
  inputs: AttachmentInput[],
  provider: EmailProviderId,
  opts: { reply?: boolean } = {}
): Promise<{ ok: true; refs: EmailAttachmentRef[] } | AttachmentFailure> {
  if (!inputs.length) return { ok: true, refs: [] };
  if (inputs.length > MAX_ATTACHMENTS) {
    return { ok: false, reason: "too_many", message: `Attach up to ${MAX_ATTACHMENTS} files` };
  }
  const prefix = attachmentPrefixFor(userId);
  const refs: EmailAttachmentRef[] = [];
  let total = 0;
  for (const input of inputs) {
    const pathname = String(input?.pathname ?? "");
    if (!pathname.startsWith(prefix) || pathname.includes("..")) {
      return { ok: false, reason: "not_found", message: NOT_AVAILABLE };
    }
    const filename = safeFilename(String(input?.filename ?? ""));
    if (isBlockedFilename(filename)) {
      return { ok: false, reason: "blocked_type", message: `${filename} can’t be sent by email` };
    }
    let meta: Awaited<ReturnType<BlobClient["head"]>>;
    try {
      meta = await client.head(pathname);
    } catch {
      return { ok: false, reason: "not_found", message: NOT_AVAILABLE };
    }
    total += meta.size;
    refs.push({
      blobKey: meta.pathname,
      filename,
      contentType: meta.contentType || "application/octet-stream",
      size: meta.size,
    });
  }
  const cap = maxAttachmentBytesFor(provider, opts);
  if (total > cap) {
    const where = provider === "outlook" ? "Outlook" : "Gmail";
    return {
      ok: false,
      reason: "too_large",
      message: `Attachments over ${mb(cap)} can’t be sent from ${where} — ${mb(total)} attached`,
    };
  }
  return { ok: true, refs };
}

/** The files' bytes at send. A Blob outage is worth a retry; a missing file never will be. */
export async function loadAttachmentBytes(
  refs: EmailAttachmentRef[]
): Promise<{ filename: string; contentType: string; bytes: Uint8Array }[]> {
  const out: { filename: string; contentType: string; bytes: Uint8Array }[] = [];
  for (const ref of refs) {
    let got: { bytes: Uint8Array } | null;
    try {
      got = await client.get(ref.blobKey);
    } catch (err) {
      throw new MailProviderError(
        "transient",
        `attachment read failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!got) throw new MailProviderError("permanent", `attachment ${ref.filename} is gone`);
    out.push({ filename: ref.filename, contentType: ref.contentType, bytes: got.bytes });
  }
  return out;
}

/**
 * Housekeeping (process-stalled): files of sends that settled more than
 * `ATTACHMENT_RETENTION_MS` ago, and uploads never sent (older than `ORPHAN_UPLOAD_TTL_MS`).
 * Rows are cleared first, then blobs deleted best-effort — a Blob outage leaves an orphan the
 * next run's listing finds, never a row pointing at nothing it still needs.
 */
export async function sweepEmailAttachments(now = new Date(), limit = 200): Promise<{ settled: number; orphans: number }> {
  const db = await getDb();
  const cutoff = new Date(now.getTime() - ATTACHMENT_RETENTION_MS);
  const picked = rowsOf<{ attachments: EmailAttachmentRef[] }>(
    await db.execute(sql`
      WITH picked AS (
        SELECT id, attachments FROM email_sends
         WHERE attachments <> '[]'::jsonb
           AND status IN ('sent','canceled','failed')
           AND updated_at < ${cutoff}
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED
      )
      UPDATE email_sends e SET attachments = '[]'::jsonb
        FROM picked WHERE e.id = picked.id
      RETURNING picked.attachments
    `)
  );
  const settledKeys = picked.flatMap((r) => (r.attachments ?? []).map((a) => a.blobKey));
  let settled = 0;
  for (const key of settledKeys) {
    if (await deleteQuietly(key)) settled++;
  }

  let orphans = 0;
  try {
    // One page a run; each run starts over. Fine at this volume.
    const page = await client.list({ prefix: `${ATTACHMENT_PREFIX}/`, limit: 1000 });
    const stale = page.blobs.filter((b) => new Date(b.uploadedAt).getTime() < now.getTime() - ORPHAN_UPLOAD_TTL_MS);
    for (const b of stale) {
      const live = rowsOf(
        await db.execute(sql`
          SELECT 1 FROM email_sends
           WHERE attachments @> jsonb_build_array(jsonb_build_object('blobKey', ${b.pathname}::text))
           LIMIT 1
        `)
      );
      if (live.length) continue;
      if (await deleteQuietly(b.pathname)) orphans++;
    }
  } catch (err) {
    reportError(err, { where: "email.attachment-sweep", level: "warning" });
  }
  return { settled, orphans };
}

async function deleteQuietly(pathname: string): Promise<boolean> {
  try {
    await client.del(pathname);
    return true;
  } catch (err) {
    reportError(err, { where: "email.attachment-sweep", level: "warning" });
    return false;
  }
}

/** Account deletion: every file under the user's prefix — sent, queued and never-sent alike. */
export async function purgeEmailAttachmentsForUser(userId: string): Promise<void> {
  const prefix = attachmentPrefixFor(userId);
  let cursor: string | undefined;
  do {
    const page = await client.list({ prefix, cursor, limit: 1000 });
    if (page.blobs.length) await client.del(page.blobs.map((b) => b.pathname));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
}
