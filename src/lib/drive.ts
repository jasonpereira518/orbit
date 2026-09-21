/**
 * Google Drive, read-only, for files the person picked (`drive.file`).
 *
 * One call: export a Doc or Slides deck as plain text. Both types support `text/plain`
 * export; Google caps any export at 10 MB and says so with `exportSizeLimitExceeded`.
 * Errors carry no response body — the processor maps them to its own sentences.
 */
const DRIVE_API = "https://www.googleapis.com/drive/v3";

/** Past this the doc is a book, not notes, and the parse would cost more than it's worth. */
export const DRIVE_EXPORT_MAX_CHARS = 200_000;

export class DriveFileUnavailableError extends Error {
  constructor() {
    super("Drive file unavailable");
    this.name = "DriveFileUnavailableError";
  }
}

export class DriveFileTooLargeError extends Error {
  constructor() {
    super("Drive file too large to read");
    this.name = "DriveFileTooLargeError";
  }
}

export async function exportDriveFileText(
  accessToken: string,
  fileId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent("text/plain")}`;
  const res = await fetchImpl(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 403) {
    const body = await res.text().catch(() => "");
    if (body.includes("exportSizeLimitExceeded")) throw new DriveFileTooLargeError();
    throw new DriveFileUnavailableError();
  }
  if (res.status === 404) throw new DriveFileUnavailableError();
  if (!res.ok) throw new Error(`Drive export returned ${res.status}`);

  const text = (await res.text()).replace(/^﻿/, "");
  if (text.length > DRIVE_EXPORT_MAX_CHARS) throw new DriveFileTooLargeError();
  return text;
}
