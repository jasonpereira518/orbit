/**
 * The browser side of capture ingest: what the pickers accept, how a file becomes bytes
 * the server can read, and the one upload call. No server imports — this is pulled into
 * client components, and anything reaching `@/db` would drag `node:fs` into the bundle.
 */
import { CAPTURE_MAX_UPLOAD_BYTES, formatUploadSize } from "@/lib/capture-limits";
import type { CaptureParseHints } from "@/lib/ai";
import type { CaptureJobView } from "@/lib/capture-jobs";
import type { CaptureJobSource } from "@/lib/capture/types";

export const CAPTURE_FILE_ACCEPT = [
  ".txt",
  ".md",
  ".markdown",
  ".ics",
  ".eml",
  "text/plain",
  "text/markdown",
  "text/calendar",
  "message/rfc822",
  "image/*",
  "application/pdf",
  ".pdf",
  "audio/*",
  ".webm",
  ".mp3",
  ".wav",
  ".m4a",
  ".ogg",
].join(",");

export const AUDIO_FILE_ACCEPT = ["audio/*", ".webm", ".mp3", ".wav", ".m4a", ".ogg"].join(",");

export async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * The size refusal, worded before anything is encoded. Null when the files fit.
 *
 * Checked in the browser because the failure downstream is invisible: an oversized body
 * is not refused by the server, it is truncated — HTTP 200, garbage later.
 */
export function oversizeMessage(files: { name: string; size: number }[]): string | null {
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes <= CAPTURE_MAX_UPLOAD_BYTES) return null;
  const limit = formatUploadSize(CAPTURE_MAX_UPLOAD_BYTES);
  return files.length === 1
    ? `${files[0]!.name} is ${formatUploadSize(totalBytes)} — the limit is ${limit} per upload`
    : `Those ${files.length} files total ${formatUploadSize(totalBytes)} — the limit is ${limit} per upload, so try smaller batches`;
}

export type CaptureUploadResult =
  | {
      ok: true;
      job: CaptureJobView;
      text: string;
      hints: CaptureParseHints;
      sources: string[];
      transcriptionEngine: string | null;
    }
  | { ok: false; error: string; status: number };

/**
 * Send media to `/api/capture/jobs`, which transcribes it inside the request and leaves a
 * `transcribed` job behind. A dropped connection after the bytes land loses nothing.
 */
export async function uploadCaptureMedia(input: {
  sourceKind: CaptureJobSource;
  text?: string;
  files: Array<File | { filename: string; mimeType: string; blob: Blob }>;
}): Promise<CaptureUploadResult> {
  const form = new FormData();
  form.set("sourceKind", input.sourceKind);
  if (input.text) form.set("text", input.text);
  for (const f of input.files) {
    if (f instanceof File) form.append("files", f, f.name);
    else form.append("files", new File([f.blob], f.filename, { type: f.mimeType }), f.filename);
  }
  const res = await fetch("/api/capture/jobs", {
    method: "POST",
    body: form,
    headers: { "x-orbit-capture": "1" },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: typeof body.error === "string" ? body.error : "Couldn’t read that file — try again?",
    };
  }
  return {
    ok: true,
    job: body.job as CaptureJobView,
    text: String(body.text ?? ""),
    hints: (body.hints as CaptureParseHints) ?? {},
    sources: Array.isArray(body.sources) ? (body.sources as string[]) : [],
    transcriptionEngine: typeof body.transcriptionEngine === "string" ? body.transcriptionEngine : null,
  };
}

/** Base64 → Blob, for a recording the recorder hands over already encoded. */
export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}
