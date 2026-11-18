/**
 * UX-walkthrough copy fixes stay fixed: mail-permission lines, generic add-contact
 * placeholders, tooltips on icon-only contact row buttons. Pure source checks.
 *
 * Run: npx tsx scripts/smoke-ux-copy.ts
 */
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");
let failures = 0;
function check(label: string, ok: boolean) {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
}

const gmail = read("src/components/recruiters/gmail-import-panel.tsx");
const outlook = read("src/components/recruiters/outlook-import-panel.tsx");
check("Gmail panel: Google is connected but can't read mail", gmail.includes("Google is connected as ${connection.emailAddress}, but Orbit can't read your mail yet. Allow mail access to find your recruiters."));
check("Outlook panel: same shape", outlook.includes("Microsoft is connected as ${connection.emailAddress}, but Orbit can't read your mail yet. Allow mail access to find your recruiters."));

const form = read("src/components/contacts/contact-form.tsx");
for (const real of ["Jason Pereira", "Amazon Web Services (AWS)", "Solutions Architect intern", "Columbia University"]) {
  check(`add-contact form has no placeholder "${real}"`, !form.includes(`placeholder="${real}"`));
}
for (const generic of ["Full name", "Company", "Role", "School"]) {
  check(`add-contact form has placeholder "${generic}"`, form.includes(`placeholder="${generic}"`));
}

const list = read("src/components/contacts/contacts-list.tsx");
check("LinkedIn row button has a title", list.includes("title={`Open ${c.fullName} on LinkedIn`}"));
check("Delete row button has a title", list.includes("title={`Delete ${name}`}"));

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-ux-copy: all checks passed");
process.exit(0);
