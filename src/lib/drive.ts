/**
 * Google Drive, read-only, for files the person picked (`drive.file`).
 *
 * One call: export a Doc or Slides deck as plain text. Both types support `text/plain`
 * export; Google caps any export at 10 MB and says so with `exportSizeLimitExceeded`.
 *
 * Every way Google says no becomes a typed error, because each one wants a different
 * response from the processor: a dead grant stops the job for a reconnect, a rate limit
 * leaves the row for later, a file Orbit isn't allowed to open asks for a re-pick, and a
 * gone file is skipped. None carries the response body — the processor maps them to its
 * own sentences.
 */
import { ReauthRequiredError } from "@/lib/errors";
import { CAPTURE_INPUT_MAX_CHARS } from "@/lib/capture/limits";

const DRIVE_API = "https://www.googleapis.com/drive/v3";

/** Capture's own ceiling: the doc goes through capture's parse, which would clip it anyway. */
export const DRIVE_EXPORT_MAX_CHARS = CAPTURE_INPUT_MAX_CHARS;

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

/** Google refused this file for this client — the pick didn't grant it (another account?). */
export class DriveNotAuthorizedError extends Error {
  constructor() {
    super("Drive file not authorized for this app");
    this.name = "DriveNotAuthorizedError";
  }
}

/** Google asked us to slow down. The row is left to try again on a later pass. */
export class DriveRateLimitedError extends Error {
  constructor() {
    super("Drive rate limited");
    this.name = "DriveRateLimitedError";
  }
}

const NOT_AUTHORIZED_REASONS = new Set([
  "appNotAuthorizedToFile",
  "insufficientPermissions",
  "insufficientFilePermissions",
]);
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

/** The `error.errors[].reason` values from a Drive error body; empty when it isn't one. */
function driveErrorReasons(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as { error?: { errors?: { reason?: unknown }[] } };
    return (parsed.error?.errors ?? [])
      .map((e) => e.reason)
      .filter((r): r is string => typeof r === "string");
  } catch {
    return [];
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

  if (res.status === 401) {
    // The access token was refused outright: the grant is dead, not just this file.
    throw new ReauthRequiredError("Google Drive refused Orbit’s access — reconnect Google");
  }
  if (res.status === 429) throw new DriveRateLimitedError();
  if (res.status === 403) {
    const reasons = driveErrorReasons(await res.text().catch(() => ""));
    if (reasons.includes("exportSizeLimitExceeded")) throw new DriveFileTooLargeError();
    if (reasons.some((r) => RATE_LIMIT_REASONS.has(r))) throw new DriveRateLimitedError();
    if (reasons.some((r) => NOT_AUTHORIZED_REASONS.has(r))) throw new DriveNotAuthorizedError();
    throw new DriveFileUnavailableError();
  }
  if (res.status === 404) throw new DriveFileUnavailableError();
  if (!res.ok) throw new Error(`Drive export returned ${res.status}`);

  const text = (await res.text()).replace(/^\uFEFF/, "");
  if (text.length > DRIVE_EXPORT_MAX_CHARS) throw new DriveFileTooLargeError();
  return text;
}
