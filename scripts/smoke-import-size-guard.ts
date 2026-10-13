/**
 * The import size guard: text bigger than one request is refused in the browser, with words.
 *
 * Pure tier: no database.
 *
 * Run: npx tsx scripts/smoke-import-size-guard.ts
 */
import {
  IMPORT_TEXT_MAX_BYTES,
  PLATFORM_REQUEST_BODY_MAX_BYTES,
  fitsInOneRequest,
  importPayloadFits,
} from "../src/lib/capture-limits";
import { IMPORT_COPY } from "../src/lib/imports/import-copy";
import { readFileSync } from "node:fs";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

check(
  "the limit leaves headroom under the platform cap",
  IMPORT_TEXT_MAX_BYTES < PLATFORM_REQUEST_BODY_MAX_BYTES,
);
check("text exactly at the limit fits", fitsInOneRequest("a".repeat(IMPORT_TEXT_MAX_BYTES)));
check("text one byte over does not", !fitsInOneRequest("a".repeat(IMPORT_TEXT_MAX_BYTES + 1)));
// Bytes, not characters: 2-byte characters, half as many of them, still fit; one more does not.
const half = Math.floor(IMPORT_TEXT_MAX_BYTES / 2);
check("measures UTF-8 bytes, not characters (fits)", fitsInOneRequest("é".repeat(half)));
check("measures UTF-8 bytes, not characters (over)", !fitsInOneRequest("é".repeat(half + 1)));
check("an empty string fits", fitsInOneRequest(""));

// The confirm call carries the selected ids beside the text: both count.
const ids = Array.from({ length: 1000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
const idBytes = JSON.stringify(ids).length;
check("text alone just under the limit still fits as text", fitsInOneRequest("a".repeat(IMPORT_TEXT_MAX_BYTES - 10)));
check("…but not once its ids ride along", !importPayloadFits("a".repeat(IMPORT_TEXT_MAX_BYTES - 10), ids));
check("text plus ids exactly at the limit fits", importPayloadFits("a".repeat(IMPORT_TEXT_MAX_BYTES - idBytes), ids));
check("ids alone (no text) are measured too", !importPayloadFits(null, Array.from({ length: Math.ceil(IMPORT_TEXT_MAX_BYTES / 40) }, () => "x".repeat(40))));
check("no text and no ids fits", importPayloadFits(null, []));
check(
  "the import runner measures the whole payload, not the text",
  /importPayloadFits\(text, "ids" in job \? job\.ids : \[\]\)/.test(readFileSync("src/lib/import-job-runner.ts", "utf8")),
);

check(
  "tooLarge tells the person what to do",
  /on its own|split/i.test(IMPORT_COPY.tooLarge),
  IMPORT_COPY.tooLarge,
);
check("tooLarge has no digits", !/\d/.test(IMPORT_COPY.tooLarge));

// A second runner must not start on a job whose first runner can still be alive
// (the continue route lives up to its 300 s maxDuration).
const route = readFileSync("src/app/api/imports/[id]/continue/route.ts", "utf8");
const maxDuration = Number(/maxDuration = (\d+)/.exec(route)?.[1]);
// Read from source: `import-stall` pulls in the database layer, which this tier avoids.
const stall = readFileSync("src/lib/import-stall.ts", "utf8");
const [, mins] = /CRON_STALL_THRESHOLD_MS = (\d+) \* 60 \* 1000/.exec(stall) ?? [];
const CRON_STALL_THRESHOLD_MS = Number(mins) * 60 * 1000;
check(
  "the stall threshold outlasts the longest runner",
  CRON_STALL_THRESHOLD_MS > maxDuration * 1000,
  `${CRON_STALL_THRESHOLD_MS}ms vs ${maxDuration}s`,
);
check("the stall threshold is six minutes", CRON_STALL_THRESHOLD_MS === 6 * 60 * 1000);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall import size guard checks passed");
process.exit(0);
