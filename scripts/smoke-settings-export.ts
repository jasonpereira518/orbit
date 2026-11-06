/**
 * Asserts a data export carries no credentials, driven by the schema rather than by memory.
 *
 * `/settings`'s export is "everything we hold about you", and `user_settings` is 58 columns
 * wide and growing — eight of which are secrets. The redaction listed those eight by name and
 * its comment claimed that "a new secret column added later should break this function's
 * type". It did not: the row was cast to `Record<string, unknown>` first, which erased the
 * type doing the checking, and destructuring known keys never complains about a key being
 * ADDED anyway. A ninth credential column would simply have ridden out in the export.
 *
 * So this walks the real table definition and fails on any credential-shaped column the
 * redaction lets through — the same shape as `smoke-purge.ts`, which fails when a new
 * user-scoped table is not purged. A comment cannot enforce a guarantee; a test can.
 *
 * Pure: reads the Drizzle table definition, touches no database.
 * Run: npx tsx scripts/smoke-settings-export.ts
 */
import { getTableConfig } from "drizzle-orm/pg-core";
import { userSettings } from "../src/db/schema";
import {
  CREDENTIAL_NAME,
  CREDENTIAL_SHAPED_BUT_SAFE,
  REDACTED_SETTINGS_COLUMNS,
  redactSettingsForExport,
} from "../src/lib/settings-export";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

/** Every property name on the row, as Drizzle knows it. */
const COLUMNS = Object.keys(userSettings as unknown as Record<string, unknown>).filter(
  (k) => !k.startsWith("_") && !k.startsWith("$")
);

function main() {
  console.log(`\nuser_settings has ${COLUMNS.length} columns`);
  check("the schema was actually read", COLUMNS.length > 20, `got ${COLUMNS.length}`);
  check(
    "the table name is what we think it is",
    getTableConfig(userSettings).name === "user_settings"
  );

  // A row with every column populated, so nothing is dropped merely for being undefined.
  const row = Object.fromEntries(COLUMNS.map((c) => [c, `value-of-${c}`]));
  const exported = redactSettingsForExport(row);

  console.log("\nevery named credential is gone");
  for (const key of REDACTED_SETTINGS_COLUMNS) {
    check(`${key} is not exported`, !(key in exported));
  }

  console.log("\nand so is anything else shaped like one");
  const credentialShaped = COLUMNS.filter(
    (c) => CREDENTIAL_NAME.test(c) && !CREDENTIAL_SHAPED_BUT_SAFE.has(c)
  );
  check(
    "the sweep finds at least the named eight",
    credentialShaped.length >= REDACTED_SETTINGS_COLUMNS.length,
    `found ${credentialShaped.length}: ${JSON.stringify(credentialShaped)}`
  );
  for (const key of credentialShaped) {
    check(
      `${key} is not exported`,
      !(key in exported),
      "a column whose name reads as a secret must never leave, listed or not"
    );
  }

  console.log("\nthe safe-by-name exceptions are deliberate and still exported");
  for (const key of CREDENTIAL_SHAPED_BUT_SAFE) {
    check(
      `${key} is a real column`,
      COLUMNS.includes(key),
      "an exception for a column that no longer exists is dead weight hiding a real one"
    );
    check(`${key} is still exported`, key in exported);
  }

  console.log("\nordinary columns survive — an export that drops your data is its own bug");
  const ordinary = COLUMNS.filter(
    (c) => !CREDENTIAL_NAME.test(c) && !REDACTED_SETTINGS_COLUMNS.includes(c as never)
  );
  check(
    "every non-credential column is present",
    ordinary.every((c) => c in exported),
    `missing: ${JSON.stringify(ordinary.filter((c) => !(c in exported)))}`
  );
  check(
    "including the ones a person would notice",
    ["userId", "aiProvider", "onboardingStep"].every((c) => !COLUMNS.includes(c) || c in exported)
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll settings-export checks passed.");
  process.exit(0);
}

main();
