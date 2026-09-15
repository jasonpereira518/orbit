/**
 * Terms acceptance is recorded once, with the version accepted. Clerk's express-consent
 * checkbox reports `legal_accepted_at` (unix ms, sometimes seconds elsewhere in Clerk's
 * API) on user.created; accounts without it accept in guided setup.
 *
 * Run: npx tsx scripts/smoke-terms-acceptance.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { TERMS_VERSION, needsTermsAcceptance, termsAcceptanceFromClerk } from "../src/lib/legal";
import { ensureUserSettings, recordTermsAcceptance } from "../src/lib/user-settings";

const USER = "smoke-terms-acceptance-user";
let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

run(async () => {
  console.log("Reading Clerk's consent");
  const ms = Date.UTC(2026, 8, 15, 12, 0, 0);
  check("no consent recorded means nothing to store", termsAcceptanceFromClerk(null) === null && termsAcceptanceFromClerk(undefined) === null && termsAcceptanceFromClerk(0) === null);
  check("milliseconds are read as milliseconds", termsAcceptanceFromClerk(ms)?.acceptedAt.getTime() === ms);
  check("seconds are read as seconds", termsAcceptanceFromClerk(ms / 1000)?.acceptedAt.getTime() === ms);
  check("the current version is attached", termsAcceptanceFromClerk(ms)?.version === TERMS_VERSION);

  console.log("Which accounts must accept");
  check("never accepted", needsTermsAcceptance(null));
  check("accepted an older text", needsTermsAcceptance("2020-01-01"));
  check("accepted this text", !needsTermsAcceptance(TERMS_VERSION));

  console.log("Writing it");
  const db = await getDb();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
  const first = new Date(ms);
  check("the first write-once record lands", await recordTermsAcceptance(USER, { acceptedAt: first, version: TERMS_VERSION }, { onlyIfUnset: true }));
  const later = new Date(ms + 86_400_000);
  check("a second write-once record is refused", !(await recordTermsAcceptance(USER, { acceptedAt: later, version: "later" }, { onlyIfUnset: true })));
  let row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, USER) });
  check("…and the first acceptance stands", row?.termsAcceptedAt?.getTime() === first.getTime() && row?.termsVersion === TERMS_VERSION);
  await recordTermsAcceptance(USER, { acceptedAt: later, version: "2027-01-01" });
  row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, USER) });
  check("an explicit acceptance of a new version overwrites", row?.termsVersion === "2027-01-01" && row?.termsAcceptedAt?.getTime() === later.getTime());

  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll terms-acceptance checks passed.");
});
