/**
 * The fingerprint undo leans on: does this contact still hold exactly what the import wrote?
 *
 * Orbit has no per-contact edit trail, and `contacts.updated_at` is useless for the question —
 * the avatar backfill and the brief writer bump it minutes after every import. So the import
 * stamps a hash of the identifying fields it wrote, and undo compares.
 *
 * Run: npx tsx scripts/smoke-import-provenance.ts
 */
import { fingerprintContact } from "../src/lib/imports/import-provenance";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const base = {
  fullName: "Priya Raman",
  company: "Stripe",
  title: "Engineer",
  email: "priya@example.com",
  linkedinUrl: "https://www.linkedin.com/in/priya-raman",
};

check("same fields, same hash", fingerprintContact(base) === fingerprintContact({ ...base }));
check("a changed name changes it", fingerprintContact(base) !== fingerprintContact({ ...base, fullName: "Priya R" }));
check("a changed company changes it", fingerprintContact(base) !== fingerprintContact({ ...base, company: "Shopify" }));
check("a changed title changes it", fingerprintContact(base) !== fingerprintContact({ ...base, title: "Staff Engineer" }));
check("a changed email changes it", fingerprintContact(base) !== fingerprintContact({ ...base, email: "p@example.com" }));
check("a changed LinkedIn changes it", fingerprintContact(base) !== fingerprintContact({ ...base, linkedinUrl: "https://www.linkedin.com/in/other" }));

// Absent and empty mean the same thing: the import wrote nothing there.
check("null and undefined agree", fingerprintContact({ fullName: "A", company: null }) === fingerprintContact({ fullName: "A" }));
check("empty string counts as nothing", fingerprintContact({ fullName: "A", company: "" }) === fingerprintContact({ fullName: "A" }));
// Whitespace and case are not edits worth vetoing an undo over.
check("trimmed", fingerprintContact({ fullName: " A " }) === fingerprintContact({ fullName: "A" }));
check("case-insensitive", fingerprintContact({ fullName: "Priya" }) === fingerprintContact({ fullName: "priya" }));
// Field boundaries must not smear: "ab"+"" and "a"+"b" are different people.
check("fields don't smear", fingerprintContact({ fullName: "ab" }) !== fingerprintContact({ fullName: "a", company: "b" }));
check("a hash, not the data", !fingerprintContact(base).includes("Priya"));

if (failures) {
  console.error(`smoke-import-provenance: ${failures} failed`);
  process.exit(1);
}
console.log("smoke-import-provenance: all checks passed");
process.exit(0);
