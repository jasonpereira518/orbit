/**
 * The Drive export call, against a stub fetch — no network. What matters is that each way
 * Google says no becomes an error the processor can map to a sentence, never a raw body.
 *
 * Run: npx tsx scripts/smoke-drive-client.ts
 */
import {
  DRIVE_EXPORT_MAX_CHARS,
  DriveFileTooLargeError,
  DriveFileUnavailableError,
  DriveNotAuthorizedError,
  DriveRateLimitedError,
  exportDriveFileText,
} from "../src/lib/drive";
import { ReauthRequiredError } from "../src/lib/errors";
import { CAPTURE_INPUT_MAX_CHARS } from "../src/lib/capture/limits";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

let lastUrl = "";
let lastAuth = "";
function stub(status: number, body: string): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    lastUrl = String(url);
    lastAuth = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(body, { status });
  }) as typeof fetch;
}

async function rejects(p: Promise<unknown>, cls: new (...a: never[]) => Error) {
  try {
    await p;
    return false;
  } catch (e) {
    return e instanceof cls;
  }
}

async function main() {
  const text = await exportDriveFileText("tok", "abc/123", stub(200, "﻿Hello Priya"));
  check("returns the text, BOM stripped", text === "Hello Priya", JSON.stringify(text));
  check("asks for plain text", lastUrl.includes("/files/abc%2F123/export?mimeType=text%2Fplain"), lastUrl);
  check("sends the bearer token", lastAuth === "Bearer tok");

  check("404 → unavailable", await rejects(exportDriveFileText("t", "x", stub(404, "{}")), DriveFileUnavailableError));
  check("403 → unavailable", await rejects(exportDriveFileText("t", "x", stub(403, '{"error":{"errors":[{"reason":"forbidden"}]}}')), DriveFileUnavailableError));
  check(
    "403 exportSizeLimitExceeded → too large",
    await rejects(exportDriveFileText("t", "x", stub(403, '{"error":{"errors":[{"reason":"exportSizeLimitExceeded"}]}}')), DriveFileTooLargeError),
  );
  check("huge text → too large", await rejects(exportDriveFileText("t", "x", stub(200, "a".repeat(DRIVE_EXPORT_MAX_CHARS + 1))), DriveFileTooLargeError));

  const reason = (r: string) => JSON.stringify({ error: { errors: [{ reason: r }] } });
  check("401 → reconnect (the grant is dead)", await rejects(exportDriveFileText("t", "x", stub(401, "{}")), ReauthRequiredError));
  check("429 → rate limited", await rejects(exportDriveFileText("t", "x", stub(429, "{}")), DriveRateLimitedError));
  for (const r of ["rateLimitExceeded", "userRateLimitExceeded"]) {
    check(`403 ${r} → rate limited`, await rejects(exportDriveFileText("t", "x", stub(403, reason(r))), DriveRateLimitedError));
  }
  for (const r of ["appNotAuthorizedToFile", "insufficientPermissions", "insufficientFilePermissions"]) {
    check(`403 ${r} → not authorized`, await rejects(exportDriveFileText("t", "x", stub(403, reason(r))), DriveNotAuthorizedError));
  }
  check("403 with a non-JSON body → unavailable", await rejects(exportDriveFileText("t", "x", stub(403, "<html>nope</html>")), DriveFileUnavailableError));
  check("the export cap is capture's own", DRIVE_EXPORT_MAX_CHARS === CAPTURE_INPUT_MAX_CHARS, String(DRIVE_EXPORT_MAX_CHARS));
  check("text at capture's cap is kept", (await exportDriveFileText("t", "x", stub(200, "a".repeat(CAPTURE_INPUT_MAX_CHARS)))).length === CAPTURE_INPUT_MAX_CHARS);

  let raw = "";
  try {
    await exportDriveFileText("t", "x", stub(500, "<html>internal secret body</html>"));
  } catch (e) {
    raw = e instanceof Error ? e.message : "";
  }
  check("a 500 never carries the body", raw.length > 0 && !raw.includes("secret"), raw);

  if (failures) {
    console.error(`smoke-drive-client: ${failures} failed`);
    process.exit(1);
  }
  console.log("smoke-drive-client: all checks passed");
  process.exit(0);
}
void main();
