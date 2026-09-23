/**
 * Every import type has a name and an icon in the history list.
 *
 * This drifted once already and silently: the list only knew four of the types, so Google,
 * Outlook and the recruiter scans rendered with no icon and printed their raw `import_type`
 * ("google_contacts · 12 created"). It was then fixed for eight, and `outlook_recruiter_scan`
 * arrived afterwards and rendered as a bare "Import".
 *
 * So the source of truth is the adapter constants themselves, read out of source text rather
 * than imported — the adapter modules reach `@/db`, and this is a pure-tier script.
 *
 * Run: npx tsx scripts/smoke-import-sources.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  IMPORT_SOURCE_LABEL,
  importSourceLabel,
} from "../src/lib/imports/import-sources";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures++;
}

/** Files that declare an `imports.import_type` value. */
const SOURCES = [
  ...readdirSync("src/lib/import-adapters")
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join("src/lib/import-adapters", f)),
  "src/lib/gmail-scan-type.ts",
  "src/lib/outlook-scan-type.ts",
];

const declared = new Map<string, string>();
for (const file of SOURCES) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(
    /export const (\w*IMPORT_TYPE)\s*=\s*"([^"]+)"/g,
  )) {
    declared.set(m[2], `${file} (${m[1]})`);
  }
}

console.log("Declared import types");
check(
  "the adapters were actually scanned",
  declared.size >= 7,
  `${declared.size} found: ${[...declared.keys()].join(", ")}`,
);

const historySrc = readFileSync(
  "src/components/imports/import-history.tsx",
  "utf8",
);
const iconBlock = historySrc.slice(
  historySrc.indexOf("const SOURCE_ICON"),
  historySrc.indexOf("const UNKNOWN_ICON"),
);
const iconKeys = new Set(
  [...iconBlock.matchAll(/^\s{2}(\w+):\s*\{/gm)].map((m) => m[1]),
);

console.log("Labels and icons");
for (const [type, where] of declared) {
  check(`${type} has a name`, Boolean(IMPORT_SOURCE_LABEL[type]), where);
  check(`${type} has an icon`, iconKeys.has(type), where);
}

console.log("Contracts");
check(
  "no label is the raw type",
  Object.entries(IMPORT_SOURCE_LABEL).every(
    ([k, v]) => v !== k && !v.includes("_"),
  ),
  Object.entries(IMPORT_SOURCE_LABEL).find(
    ([k, v]) => v === k || v.includes("_"),
  )?.[0] ?? "",
);
check(
  "the label table has no entry the adapters do not declare",
  Object.keys(IMPORT_SOURCE_LABEL).every((k) => declared.has(k)),
  Object.keys(IMPORT_SOURCE_LABEL).find((k) => !declared.has(k)) ?? "",
);
check(
  "the icon map has no entry the adapters do not declare",
  [...iconKeys].every((k) => declared.has(k)),
  [...iconKeys].find((k) => !declared.has(k)) ?? "",
);
check(
  "an unheard-of type still gets a name",
  importSourceLabel("something_new") === "Import",
);
check("a missing type still gets a name", importSourceLabel(null) === "Import");

if (failures) {
  console.error(
    `\n${failures} import source check${failures === 1 ? "" : "s"} failed`,
  );
  process.exit(1);
}
console.log("\nimport source smoke tests passed");
process.exit(0);
