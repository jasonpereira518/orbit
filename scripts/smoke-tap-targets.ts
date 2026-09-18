/**
 * Every small icon button on the touch surfaces the audit measured carries `tap-target`,
 * and each crowded cluster widens its gap on coarse pointers so hit areas never overlap.
 * Pure: parses the TSX with the TypeScript compiler, touches no database.
 * Run: npx tsx scripts/smoke-tap-targets.ts
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

const FILES: Record<string, number> = {
  "src/components/contacts/contacts-list.tsx": 3,
  "src/components/capture/capture-summary.tsx": 1,
  "src/components/capture/capture-source-card.tsx": 2,
  "src/components/capture/ignored-people-section.tsx": 1,
  "src/components/reminders/reminder-card.tsx": 1,
  "src/components/reminders/reminder-done-snooze.tsx": 2,
  "src/components/reminders/suggested-reminders-panel.tsx": 3,
};
const CLUSTER_GAPS: Array<[string, string]> = [
  ["src/components/contacts/contacts-list.tsx", "pointer-coarse:gap-4"],
  ["src/components/reminders/reminder-card.tsx", "pointer-coarse:gap-4"],
  ["src/components/reminders/reminder-done-snooze.tsx", "pointer-coarse:gap-4"],
  ["src/components/reminders/suggested-reminders-panel.tsx", "pointer-coarse:gap-3"],
];
const SMALL = new Set(["icon-xs", "icon-sm", "icon"]);

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

function attr(el: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return el.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
}

/** `size="icon-sm"`, or `buttonVariants({ …, size: "icon-sm" })` inside className. */
function sizeOf(el: ts.JsxOpeningLikeElement): string | null {
  const size = attr(el, "size");
  if (size?.initializer && ts.isStringLiteral(size.initializer)) return size.initializer.text;
  const m = (attr(el, "className")?.getText() ?? "").match(/size:\s*"([a-z-]+)"/);
  return m ? m[1] : null;
}

for (const [file, expected] of Object.entries(FILES)) {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let small = 0;
  ts.forEachChild(sf, function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const size = sizeOf(node);
      if (size && SMALL.has(size)) {
        small += 1;
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const cls = attr(node, "className")?.getText() ?? "";
        check(`${file}:${line} has tap-target`, /\btap-target\b/.test(cls), cls || "(no className)");
      }
    }
    ts.forEachChild(node, visit);
  });
  check(`${file} still has its ${expected} small icon button(s)`, small === expected, `found ${small}`);
}
for (const [file, gap] of CLUSTER_GAPS) {
  check(`${file} widens its cluster with ${gap}`, readFileSync(file, "utf8").includes(gap));
}
check("globals.css defines the utility", /@utility tap-target\b/.test(readFileSync("src/app/globals.css", "utf8")));

if (failures) {
  console.error(`\nsmoke-tap-targets: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-tap-targets: ok");
process.exit(0);
