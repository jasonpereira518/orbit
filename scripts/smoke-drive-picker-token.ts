/**
 * `driveReadinessReason` — the pure seam behind `checkDriveReadiness` (`src/actions/drive.ts`)
 * that decides why the stored Google grant can't export picked files yet, from the row alone.
 *
 * Also pins the C1 fix: the stored grant carries every scope the person ever connected
 * (Gmail, Calendar…), so no server action in `src/actions/drive.ts` may hand an access token
 * to the browser. The Picker gets a drive.file-only token from Google Identity Services.
 *
 * Pins: no row is "not connected"; a lapsed `needs_reauth` row is "needs_reconnect" even
 * though its scopes are still on the row (mirrors `previewGoogleContacts` in
 * `src/actions/imports.ts`); an active row missing the drive.file scope is "needs_consent";
 * an active row with it is usable (`null`).
 *
 * Run: npx tsx scripts/smoke-drive-picker-token.ts
 */
import { driveReadinessReason } from "../src/lib/drive-picker-token";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import { readFileSync } from "node:fs";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name}`, extra ?? "");
}

check("no row at all is not connected", driveReadinessReason(undefined) === "not_connected");

check(
  "a lapsed row is needs_reconnect, even with drive scope still on it",
  driveReadinessReason({ status: "needs_reauth", scopes: GOOGLE_SCOPES.drive }) === "needs_reconnect",
);

check(
  "an active row missing drive.file is needs_consent",
  driveReadinessReason({ status: "active", scopes: GOOGLE_SCOPES.gmailRead }) === "needs_consent",
);

check(
  "an active row with no scopes at all is needs_consent",
  driveReadinessReason({ status: "active", scopes: null }) === "needs_consent",
);

check(
  "an active row with drive.file is usable",
  driveReadinessReason({ status: "active", scopes: GOOGLE_SCOPES.drive }) === null,
);

check(
  "an active row with drive.file among other scopes is usable",
  driveReadinessReason({ status: "active", scopes: `${GOOGLE_SCOPES.openid} ${GOOGLE_SCOPES.drive}` }) === null,
);

const actionSource = readFileSync("src/actions/drive.ts", "utf8");
check(
  "no Drive server action returns an access token to the browser",
  !/accessToken\s*:/.test(actionSource) && !/getDrivePickerToken/.test(actionSource),
);
check(
  "the readiness check discards the refreshed token",
  /await getValidAccessToken\(userId\);/.test(actionSource),
);

const pickerSource = readFileSync("src/lib/imports/google-picker.ts", "utf8");
check(
  "the Picker token comes from Google Identity Services, drive.file only",
  pickerSource.includes("initTokenClient") &&
    pickerSource.includes("https://www.googleapis.com/auth/drive.file") &&
    /include_granted_scopes:\s*false/.test(pickerSource),
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
