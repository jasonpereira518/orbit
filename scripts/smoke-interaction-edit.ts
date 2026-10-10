/**
 * The interaction sheet's edit form follows the interaction it was seeded from. Stepping to
 * another interaction while editing used to keep the form open and save A's notes onto B.
 *
 * Pure: no database. Run: npx tsx scripts/smoke-interaction-edit.ts
 */
import { readFileSync } from "node:fs";
import { editTarget } from "../src/lib/interaction-edit";

function check(label: string, condition: boolean) {
  if (!condition) throw new Error(`${label} failed`);
  console.log(`  ok  ${label}`);
}

check("editing A while A is open targets A", editTarget("a", "a") === "a");
check("stepping to B closes the form", editTarget("a", "b") === null);
check("the sheet losing its row under a refresh closes the form", editTarget("a", null) === null);
check("not editing targets nothing", editTarget(null, "a") === null);

const sheet = readFileSync("src/components/contacts/interaction-detail-sheet.tsx", "utf8");
check("the sheet derives editing from editTarget", /editTarget\(editingId, interactionId\)/.test(sheet));
check("both step chevrons are disabled while editing",
  /disabled=\{pending \|\| editing \|\| !canStep\.newer\}/.test(sheet) &&
    /disabled=\{pending \|\| editing \|\| !canStep\.older\}/.test(sheet));
check("no setEditing state remains", !/\bsetEditing\(/.test(sheet));

console.log("\nsmoke-interaction-edit: all checks passed");
process.exit(0);
