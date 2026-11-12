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
  /** Who owns it, "You" for the person's own docs. Listing only — the scan never reads it. */
  owner?: string | null;
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

/**
 * A .docx is a ZIP. The 10 MB transfer cap bounds the bytes on the wire, not what they expand
 * to, so a 9 MB archive of highly compressible XML was a decompression bomb aimed at the
 * scan's memory. Only `word/document.xml` is ever read; these bound it and the archive's shape
 * before JSZip allocates anything.
 */
const DOCX_MAX_ENTRIES = 1_000;
const DOCX_MAX_XML_BYTES = 32 * 1024 * 1024;
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

type GoogleFileJson = {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  webViewLink?: string;
  trashed?: boolean;
  owners?: { displayName?: string; me?: boolean }[];
};

const GOOGLE_FILE_FIELDS = "id,name,mimeType,modifiedTime,webViewLink,trashed,owners(displayName,me)";

function googleFile(f: GoogleFileJson | undefined): CloudFile | null {
  if (!f?.id || !f.name || f.trashed || f.mimeType !== DRIVE_MIME.doc) return null;
  const owner = f.owners?.[0];
  return {
    provider: "google",
    id: f.id,
    name: f.name,
    modifiedTime: f.modifiedTime ?? new Date(0).toISOString(),
    webUrl: f.webViewLink ?? null,
    owner: owner?.me ? "You" : (owner?.displayName ?? null),
  };
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
  createdBy?: { user?: { displayName?: string } };
};

function graphFile(item: GraphItemJson | undefined): CloudFile | null {
  if (!item?.id || !item.name || !item.file || item.deleted) return null;
  if (!isReadableOneDriveName(item.name)) return null;
  if (typeof item.size === "number" && item.size > MAX_ONEDRIVE_BYTES) return null;
  return {
    provider: "microsoft",
    id: item.id,
    name: item.name,
    modifiedTime: item.lastModifiedDateTime ?? new Date(0).toISOString(),
    webUrl: item.webUrl ?? null,
    owner: item.createdBy?.user?.displayName ?? null,
  };
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

/** A .docx's body as plain text: paragraphs become lines, tabs and breaks survive. */
export async function docxToText(data: ArrayBuffer | Uint8Array): Promise<string> {
  if (data.byteLength > MAX_ONEDRIVE_BYTES) throw new DriveFileTooLargeError();

  const zip = await JSZip.loadAsync(data);
  if (Object.keys(zip.files).length > DOCX_MAX_ENTRIES) throw new DriveFileTooLargeError();

  const entry = zip.file("word/document.xml");
  if (!entry) throw new DriveFileUnavailableError();

  // JSZip reads the size from the archive's central directory, so this refuses a bomb before
  // it inflates anything. The length check afterwards covers a directory that lied.
  const declared = (entry as unknown as { _data?: { uncompressedSize?: number } })._data
    ?.uncompressedSize;
  if (typeof declared === "number" && declared > DOCX_MAX_XML_BYTES) {
    throw new DriveFileTooLargeError();
  }

  const xml = await entry.async("string");
  if (xml.length > DOCX_MAX_XML_BYTES) throw new DriveFileTooLargeError();

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
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ONEDRIVE_BYTES) throw new DriveFileTooLargeError();
  const lower = file.name.toLowerCase();
  // A chunked body has no Content-Length to refuse up front, so cap it while it streams.
  const body = await readBodyCapped(res, MAX_ONEDRIVE_BYTES);
  if (!body) throw new DriveFileTooLargeError();
  let text: string;
  if (lower.endsWith(".docx")) text = await docxToText(body);
  else if (lower.endsWith(".vtt")) text = vttToText(body.toString("utf8"));
  else text = body.toString("utf8");
  text = text.replace(/^﻿/, "");
  if (text.length > DRIVE_EXPORT_MAX_CHARS) throw new DriveFileTooLargeError();
  return text;
}

// ── Previews ─────────────────────────────────────────────────────────────────

const THUMB_MAX_BYTES = 512 * 1024;
const THUMB_TYPES = /^image\/(png|jpeg|gif|webp)$/;
/** Drive's thumbnail links all live here. The bearer token is only ever sent to this host. */
const GOOGLE_THUMB_HOST = /(^|\.)googleusercontent\.com$/;

function httpsUrl(value: unknown, host?: RegExp): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || (host && !host.test(url.hostname))) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * A doc's first-page thumbnail, ready for an `<img>`. Drive's link needs the token, so it is
 * fetched here and handed back as a `data:` URL; OneDrive's is pre-authenticated, so its URL
 * goes back as is. Null when the doc has none (OneDrive text files, a doc Drive hasn't rendered).
 */
export async function fileThumbnail(ctx: CloudCtx, provider: CloudProvider, file: { id: string; name: string }): Promise<string | null> {
  if (provider === "google") {
    const meta = await googleJson<{ thumbnailLink?: string }>(ctx, `${DRIVE_API}/files/${encodeURIComponent(file.id)}?fields=thumbnailLink`);
    const link = httpsUrl(meta.thumbnailLink, GOOGLE_THUMB_HOST);
    if (!link) return null;
    const res = await (ctx.fetchImpl ?? fetch)(link.toString().replace(/=s\d+$/, "=s400"), {
      headers: { authorization: `Bearer ${ctx.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!res.ok || !THUMB_TYPES.test(type)) return null;
    const bytes = await readBodyCapped(res, THUMB_MAX_BYTES);
    if (!bytes) return null;
    return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
  }
  if (!file.name.toLowerCase().endsWith(".docx")) return null;
  const json = await graphJson<{ url?: string }>(ctx, `${GRAPH_API}/me/drive/items/${encodeURIComponent(file.id)}/thumbnails/0/medium`);
  return httpsUrl(json.url)?.toString() ?? null;
}

export const PREVIEW_MAX_CHARS = 1_500;

/** The opening of a doc for the peek: blank-line runs and space runs squeezed, cut at a word. */
export function previewText(text: string, max = PREVIEW_MAX_CHARS): { text: string; truncated: boolean } {
  const clean = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (clean.length <= max) return { text: clean, truncated: false };
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return { text: `${(space > max * 0.8 ? cut.slice(0, space) : cut).trimEnd()}…`, truncated: true };
}
