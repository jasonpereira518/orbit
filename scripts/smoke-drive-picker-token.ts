/**
 * `pickerTokenReason` — the pure seam behind `getDrivePickerToken` (`src/actions/drive.ts`)
 * that decides why a Drive Picker token can't be handed back, from the connection row alone.
 *
 * Pins: no row is "not connected"; a lapsed `needs_reauth` row is "needs_reconnect" even
 * though its scopes are still on the row (mirrors `previewGoogleContacts` in
 * `src/actions/imports.ts`); an active row missing the drive.file scope is "needs_consent";
 * an active row with it is usable (`null`).
 *
 * Run: npx tsx scripts/smoke-drive-picker-token.ts
 */
import { pickerTokenReason } from "../src/lib/drive-picker-token";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name}`, extra ?? "");
}

check("no row at all is not connected", pickerTokenReason(undefined) === "not_connected");

check(
  "a lapsed row is needs_reconnect, even with drive scope still on it",
  pickerTokenReason({ status: "needs_reauth", scopes: GOOGLE_SCOPES.drive }) === "needs_reconnect",
);

check(
  "an active row missing drive.file is needs_consent",
  pickerTokenReason({ status: "active", scopes: GOOGLE_SCOPES.gmailRead }) === "needs_consent",
);

check(
  "an active row with no scopes at all is needs_consent",
  pickerTokenReason({ status: "active", scopes: null }) === "needs_consent",
);

check(
  "an active row with drive.file is usable",
  pickerTokenReason({ status: "active", scopes: GOOGLE_SCOPES.drive }) === null,
);

check(
  "an active row with drive.file among other scopes is usable",
  pickerTokenReason({ status: "active", scopes: `${GOOGLE_SCOPES.openid} ${GOOGLE_SCOPES.drive}` }) === null,
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
