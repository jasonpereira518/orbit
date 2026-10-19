/**
 * Google Drive and OneDrive, read-only, for cloud notes: list recent docs, follow changes,
 * read a doc as plain text.
 *
 * Network only — every function takes an access token and an injectable `fetch`, so the scan
 * smoke drives it with canned responses. `cloudAccessToken` is the one place that touches the
 * stored grants. Google needs `drive.readonly` (purpose `drive_scan`), Microsoft `Files.Read`
 * (purpose `files`); the Picker's `drive.file` grant cannot list anything.
 *
 * Errors reuse `drive.ts`'s typed classes for both providers, so the capture path maps one set
 * of failures to sentences.
 */
import JSZip from "jszip";
import {
  DRIVE_EXPORT_MAX_CHARS,
  DriveFileTooLargeError,
  DriveFileUnavailableError,
  DriveRateLimitedError,
  exportDriveFileText,
} from "@/lib/drive";
import { ReauthRequiredError } from "@/lib/errors";
import { googleFetchWithRetry } from "@/lib/google-fetch";
import { assertGraphUrl as assertGraphLink, GRAPH_API, graphFetchWithRetry } from "@/lib/graph-fetch";
import { DRIVE_MIME } from "@/lib/imports/drive-triage";
import { readBodyCapped } from "@/lib/net-guard";

export type CloudProvider = "google" | "microsoft";
export const CLOUD_PROVIDERS: readonly CloudProvider[] = ["google", "microsoft"];

export function isCloudProvider(value: unknown): value is CloudProvider {
  return value === "google" || value === "microsoft";
}

export type CloudFile = {
  provider: CloudProvider;
  id: string;
  name: string;
  /** ISO timestamp. */
  modifiedTime: string;
  webUrl: string | null;
};

export type CloudCtx = { token: string; fetchImpl?: typeof fetch };

/**
 * The stored change cursor is dead: OneDrive's `410 Gone` (`resyncRequired`) for a delta
 * token it no longer tracks, or Drive's `400 Invalid Value` on `pageToken`. Both providers'
 * contract is "discard it and start over", so this is neither a dead grant nor a transient
 * failure — retrying the same cursor can never succeed.
 */
export class CloudCursorExpiredError extends Error {
  constructor(provider: CloudProvider) {
    super(provider === "google" ? "Drive change cursor expired" : "OneDrive delta link expired");
    this.name = "CloudCursorExpiredError";
  }
}

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const TIMEOUT_MS = 15_000;
/** OneDrive files bigger than this are never downloaded — no notes doc is 10 MB. */
const MAX_ONEDRIVE_BYTES = 10 * 1024 * 1024;
/** What a OneDrive file has to end in to be read. Word docs, plain text, and Teams/Zoom transcripts. */
const ONEDRIVE_EXTENSIONS = [".docx", ".txt", ".md", ".vtt"] as const;

export function isReadableOneDriveName(name: string): boolean {
  const lower = name.toLowerCase();
  return ONEDRIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** The provider's access token, refreshed when close to expiry. Throws `ReauthRequiredError` on a dead grant. */
export async function cloudAccessToken(userId: string, provider: CloudProvider): Promise<string> {
  if (provider === "google") {
    const { getValidAccessToken } = await import("@/lib/gmail");
    return getValidAccessToken(userId, { minValidityMs: 120_000 });
  }
  const { getValidAccessToken } = await import("@/lib/outlook");
  return getValidAccessToken(userId, { minValidityMs: 120_000 });
}

// ── Google ────────────────────────────────────────────────────────────────────

type GoogleFileJson = { id?: string; name?: string; mimeType?: string; modifiedTime?: string; webViewLink?: string; trashed?: boolean };

const GOOGLE_FILE_FIELDS = "id,name,mimeType,modifiedTime,webViewLink,trashed";

function googleFile(f: GoogleFileJson | undefined): CloudFile | null {
  if (!f?.id || !f.name || f.trashed || f.mimeType !== DRIVE_MIME.doc) return null;
  return { provider: "google", id: f.id, name: f.name, modifiedTime: f.modifiedTime ?? new Date(0).toISOString(), webUrl: f.webViewLink ?? null };
}

async function googleJson<T>(ctx: CloudCtx, url: string): Promise<T> {
  const res = await googleFetchWithRetry(url, {
    timeoutMs: TIMEOUT_MS,
    fetchImpl: ctx.fetchImpl,
    headers: { authorization: `Bearer ${ctx.token}` },
  });
  if (res.status === 401) throw new ReauthRequiredError("Google Drive refused Orbit’s access — reconnect Google");
  if (res.status === 403) {
    const body = await res.text().catch(() => "");
    if (/rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(body)) throw new DriveRateLimitedError();
    // A grant without drive.readonly: listing needs the cloud-notes permission.
    throw new ReauthRequiredError("Google Drive needs permission to list your Docs — reconnect Google");
  }
  if (res.status === 429) throw new DriveRateLimitedError();
  if (res.status === 400) {
    // Drive's answer to a page token it no longer accepts names the parameter.
    const body = await res.text().catch(() => "");
    if (/"location"\s*:\s*"pageToken"/.test(body)) throw new CloudCursorExpiredError("google");
  }
  if (!res.ok) throw new Error(`Drive returned ${res.status}`);
  return (await res.json()) as T;
}

/** Drive's query language quotes with single quotes and escapes them (and backslashes) with a backslash. */
function driveQuoted(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

// ── Microsoft ─────────────────────────────────────────────────────────────────

type GraphItemJson = {
  id?: string;
  name?: string;
  lastModifiedDateTime?: string;
  webUrl?: string;
  size?: number;
  file?: unknown;
  deleted?: unknown;
};

function graphFile(item: GraphItemJson | undefined): CloudFile | null {
  if (!item?.id || !item.name || !item.file || item.deleted) return null;
  if (!isReadableOneDriveName(item.name)) return null;
  if (typeof item.size === "number" && item.size > MAX_ONEDRIVE_BYTES) return null;
  return { provider: "microsoft", id: item.id, name: item.name, modifiedTime: item.lastModifiedDateTime ?? new Date(0).toISOString(), webUrl: item.webUrl ?? null };
}

async function graphResponse(ctx: CloudCtx, url: string): Promise<Response> {
  const res = await graphFetchWithRetry(url, {
    timeoutMs: TIMEOUT_MS,
    fetchImpl: ctx.fetchImpl,
    headers: { authorization: `Bearer ${ctx.token}` },
  });
  if (res.status === 401) throw new ReauthRequiredError("OneDrive refused Orbit’s access — reconnect Microsoft");
  if (res.status === 403) throw new ReauthRequiredError("OneDrive needs permission to read your files — reconnect Microsoft");
  if (res.status === 429) throw new DriveRateLimitedError();
  if (res.status === 404) throw new DriveFileUnavailableError();
  // Only a delta link answers 410: the token has expired and Graph wants a fresh delta.
  if (res.status === 410) throw new CloudCursorExpiredError("microsoft");
  if (!res.ok) throw new Error(`OneDrive returned ${res.status}`);
  return res;
}

async function graphJson<T>(ctx: CloudCtx, url: string): Promise<T> {
  return (await (await graphResponse(ctx, url)).json()) as T;
}

/** Graph search terms are quoted with single quotes, doubled to escape. */
function graphQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A cursor or page link is only ever one Graph handed back — never follow anything else with the token. */
function assertGraphUrl(url: string) {
  assertGraphLink(url, "Bad OneDrive cursor");
}

// ── Listing ──────────────────────────────────────────────────────────────────

/**
 * Recent docs, newest first. `query` narrows by name; `since` drops anything older (the
 * backfill's 30 days). One page — `next` is the page token to ask for more.
 */
export async function listRecentFiles(
  ctx: CloudCtx,
  provider: CloudProvider,
  opts: { query?: string; since?: Date; pageToken?: string | null; pageSize?: number } = {},
): Promise<{ files: CloudFile[]; next: string | null }> {
  const query = opts.query?.trim().slice(0, 100) || "";
  const pageSize = Math.min(Math.max(opts.pageSize ?? 30, 1), 100);
  if (provider === "google") {
    const q = [`mimeType='${DRIVE_MIME.doc}'`, "trashed=false"];
    if (query) q.push(`name contains ${driveQuoted(query)}`);
    if (opts.since) q.push(`modifiedTime > '${opts.since.toISOString()}'`);
    const params = new URLSearchParams({
      q: q.join(" and "),
      orderBy: "modifiedTime desc",
      pageSize: String(pageSize),
      fields: `nextPageToken,files(${GOOGLE_FILE_FIELDS})`,
      spaces: "drive",
    });
    if (opts.pageToken) params.set("pageToken", opts.pageToken);
    const json = await googleJson<{ files?: GoogleFileJson[]; nextPageToken?: string }>(ctx, `${DRIVE_API}/files?${params}`);
    return { files: (json.files ?? []).map(googleFile).filter((f): f is CloudFile => f !== null), next: json.nextPageToken ?? null };
  }

  // Graph has no "files changed since" listing: `recent` for the default view, `search` by name.
  let url: string;
  if (opts.pageToken) {
    assertGraphUrl(opts.pageToken);
    url = opts.pageToken;
  } else if (query) {
    url = `${GRAPH_API}/me/drive/root/search(q=${encodeURIComponent(graphQuoted(query))})?$top=${pageSize}`;
  } else {
    url = `${GRAPH_API}/me/drive/recent?$top=${pageSize}`;
  }
  const json = await graphJson<{ value?: GraphItemJson[]; "@odata.nextLink"?: string }>(ctx, url);
  const since = opts.since?.getTime() ?? 0;
  const files = (json.value ?? [])
    .map(graphFile)
    .filter((f): f is CloudFile => f !== null && Date.parse(f.modifiedTime) > since)
    .sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
  return { files, next: json["@odata.nextLink"] ?? null };
}

// ── Changes ──────────────────────────────────────────────────────────────────

/** A cursor at "now": the next `listChanges` returns only what changes after this call. */
export async function startChangeCursor(ctx: CloudCtx, provider: CloudProvider): Promise<string> {
  if (provider === "google") {
    const json = await googleJson<{ startPageToken?: string }>(ctx, `${DRIVE_API}/changes/startPageToken`);
    if (!json.startPageToken) throw new Error("Drive returned no start page token");
    return json.startPageToken;
  }
  const json = await graphJson<{ "@odata.deltaLink"?: string }>(ctx, `${GRAPH_API}/me/drive/root/delta?token=latest`);
  if (!json["@odata.deltaLink"]) throw new Error("OneDrive returned no delta link");
  return json["@odata.deltaLink"];
}

/**
 * One page of changes after `cursor`. Returns the cursor to store next — the following page
 * while `done` is false, the "from now on" cursor once it is true.
 */
export async function listChanges(
  ctx: CloudCtx,
  provider: CloudProvider,
  cursor: string,
  pageSize = 25,
): Promise<{ files: CloudFile[]; cursor: string; done: boolean }> {
  if (provider === "google") {
    const params = new URLSearchParams({
      pageToken: cursor,
      pageSize: String(pageSize),
      spaces: "drive",
      includeRemoved: "false",
      fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${GOOGLE_FILE_FIELDS}))`,
    });
    const json = await googleJson<{ changes?: { removed?: boolean; file?: GoogleFileJson }[]; nextPageToken?: string; newStartPageToken?: string }>(
      ctx,
      `${DRIVE_API}/changes?${params}`,
    );
    const files = (json.changes ?? []).filter((c) => !c.removed).map((c) => googleFile(c.file)).filter((f): f is CloudFile => f !== null);
    const next = json.nextPageToken ?? json.newStartPageToken;
    if (!next) throw new Error("Drive returned no next cursor");
    return { files, cursor: next, done: !json.nextPageToken };
  }
  assertGraphUrl(cursor);
  const json = await graphJson<{ value?: GraphItemJson[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }>(ctx, cursor);
  const files = (json.value ?? []).map(graphFile).filter((f): f is CloudFile => f !== null);
  const next = json["@odata.nextLink"] ?? json["@odata.deltaLink"];
  if (!next) throw new Error("OneDrive returned no next cursor");
  return { files, cursor: next, done: !json["@odata.nextLink"] };
}

// ── Reading ──────────────────────────────────────────────────────────────────

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return XML_ENTITIES[code.toLowerCase()] ?? m;
  });
}

/**
 * Ceiling on the inflated `word/document.xml`. Markup outweighs text many times over, so this is
 * generous next to capture's character cap, but it stops a small zip that expands to gigabytes.
 */
export const MAX_DOCX_XML_BYTES = 16 * 1024 * 1024;

/**
 * Inflate one zip entry as UTF-8, refusing once it passes `maxBytes`. The declared size in the
 * zip header is checked first, but it can lie, so the stream is counted as it inflates.
 */
async function inflateCapped(entry: JSZip.JSZipObject, maxBytes: number): Promise<string> {
  const declared = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  if (typeof declared === "number" && declared > maxBytes) throw new DriveFileTooLargeError();
  return new Promise<string>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    // Public at runtime (it backs `nodeStream`), missing from the type declarations.
    const stream = (entry as unknown as { internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array> })
      .internalStream("uint8array");
    stream
      .on("data", (chunk: Uint8Array) => {
        if (settled) return;
        total += chunk.byteLength;
        if (total > maxBytes) {
          settled = true;
          stream.pause();
          chunks.length = 0;
          reject(new DriveFileTooLargeError());
          return;
        }
        chunks.push(chunk);
      })
      .on("error", (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      })
      .on("end", () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      })
      .resume();
  });
}

/** A .docx's body as plain text: paragraphs become lines, tabs and breaks survive. */
export async function docxToText(data: ArrayBuffer | Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new DriveFileUnavailableError();
  const xml = await inflateCapped(entry, MAX_DOCX_XML_BYTES);
  const text = xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br\/>|<w:cr\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeXmlEntities(text).replace(/\n{3,}/g, "\n\n").trim();
}

/** A WebVTT transcript as `Speaker: line` text, timings and cue numbers dropped. */
export function vttToText(vtt: string): string {
  return vtt
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^WEBVTT/.test(line) && !/-->/.test(line) && !/^\d+$/.test(line.trim()) && !/^NOTE\b/.test(line))
    .map((line) => line.replace(/<v\s+([^>]+)>(.*?)(<\/v>)?$/, "$1: $2").replace(/<[^>]+>/g, ""))
    .join("\n");
}

/** The whole doc as plain text, capped at capture's input ceiling. */
export async function readFileText(ctx: CloudCtx, provider: CloudProvider, file: { id: string; name: string }): Promise<string> {
  if (provider === "google") return exportDriveFileText(ctx.token, file.id, ctx.fetchImpl);

  if (!isReadableOneDriveName(file.name)) throw new DriveFileUnavailableError();
  const res = await graphResponse(ctx, `${GRAPH_API}/me/drive/items/${encodeURIComponent(file.id)}/content`);
  // Counted as it streams: a missing or understated Content-Length must not let the whole body buffer.
  const body = await readBodyCapped(res, MAX_ONEDRIVE_BYTES);
  if (!body) throw new DriveFileTooLargeError();
  const lower = file.name.toLowerCase();
  let text: string;
  if (lower.endsWith(".docx")) text = await docxToText(body);
  else if (lower.endsWith(".vtt")) text = vttToText(body.toString("utf8"));
  else text = body.toString("utf8");
  text = text.replace(/^﻿/, "");
  if (text.length > DRIVE_EXPORT_MAX_CHARS) throw new DriveFileTooLargeError();
  return text;
}
