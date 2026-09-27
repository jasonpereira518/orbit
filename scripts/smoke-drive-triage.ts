/**
 * Name-and-metadata triage for picked Drive files. Free and instant by design — no model
 * sees anything until the person has chosen — so it only has to be right about the obvious.
 *
 * Run: npx tsx scripts/smoke-drive-triage.ts
 */
import { DRIVE_MIME, triageDriveFile } from "../src/lib/imports/drive-triage";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const NOW = new Date("2026-09-21T12:00:00Z");
const RECENT = "2026-08-01T10:00:00Z";
const OLD = "2023-02-01T10:00:00Z";
const doc = (name: string, modifiedTime = RECENT, mimeType: string = DRIVE_MIME.doc) =>
  triageDriveFile({ id: "x", name, mimeType, modifiedTime }, NOW);

const likely = [
  "1:1 Priya / Jason",
  "Weekly sync notes",
  "Coffee with Marco",
  "Interview debrief — Lena Okafor",
  "2026-08-14 call with Stripe",
  "Standup",
  "Jason <> Ana intro",
  "Retro Q3",
];
for (const name of likely) check(`likely: ${name}`, doc(name).likely, doc(name).why);

const unlikely = [
  "Resume 2026",
  "Meeting notes template",
  "Q4 budget",
  "Product roadmap",
  "Pitch deck",
  "PRD: onboarding",
  "Invoice #221",
];
for (const name of unlikely) check(`not likely: ${name}`, !doc(name).likely, doc(name).why);

check("untitled is not pre-picked", !doc("Untitled document").likely);
check("untitled says why", /nothing to go on/i.test(doc("Untitled document").why));
check("a negative word beats a positive one", !doc("1:1 notes template").likely);
check("an old notes doc is still likely", doc("Weekly sync notes", OLD).likely);
check("a plain name that's recent is not pre-picked", !doc("Thoughts", RECENT).likely);
check("slides named like a meeting are likely", doc("Team sync", RECENT, DRIVE_MIME.slides).likely);
for (const name of [...likely, ...unlikely, "Untitled document"]) {
  const why = doc(name).why;
  check(`why reads clean: ${name}`, why.length > 0 && !why.endsWith(".") && !/'/.test(why), why);
}

if (failures) {
  console.error(`smoke-drive-triage: ${failures} failed`);
  process.exit(1);
}
console.log("smoke-drive-triage: all checks passed");
process.exit(0);
