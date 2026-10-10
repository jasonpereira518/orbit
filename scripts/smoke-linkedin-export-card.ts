/**
 * When the LinkedIn export card shows, and what it says (Sprint B, B3).
 *
 * Run: npx tsx scripts/smoke-linkedin-export-card.ts
 */
import { linkedinCardState } from "../src/lib/linkedin-export-card";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

check("hidden during onboarding", linkedinCardState({ imported: false, requestedAt: null, onboardingDone: false }).show === false);
check("hidden once anything from LinkedIn is imported", linkedinCardState({ imported: true, requestedAt: null, onboardingDone: true }).show === false);
const start = linkedinCardState({ imported: false, requestedAt: null, onboardingDone: true });
check("the start card when nothing was requested", start.show && start.mode === "start", start);
const req = linkedinCardState({ imported: false, requestedAt: "2026-10-08T10:00:00Z", onboardingDone: true });
check("after a request, when the export should be ready (a day later)",
  req.show && req.mode === "requested" && req.readyIso === "2026-10-09T10:00:00.000Z", req);
check("a Date and a string read the same",
  JSON.stringify(linkedinCardState({ imported: false, requestedAt: new Date("2026-10-08T10:00:00Z"), onboardingDone: true })) === JSON.stringify(req));

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nlinkedin-export-card: ok");
process.exit(0);
