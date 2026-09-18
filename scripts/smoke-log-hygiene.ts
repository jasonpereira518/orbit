/**
 * Logs carry a keyed, day-scoped tag instead of an IP, and a length instead of model
 * output. Pure. Run: npx tsx scripts/smoke-log-hygiene.ts
 */
import { readFileSync } from "node:fs";
import { ipLogTag } from "../src/lib/log-redaction";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const day1 = new Date("2026-09-15T10:00:00Z");
const day2 = new Date("2026-09-16T10:00:00Z");
const tag = ipLogTag("203.0.113.7", day1);
check("a 12-hex-character tag", /^[0-9a-f]{12}$/.test(tag), tag);
check("the IP is not in it", !tag.includes("203"));
check("stable within a day", ipLogTag("203.0.113.7", new Date("2026-09-15T23:00:00Z")) === tag);
check("rotates across days", ipLogTag("203.0.113.7", day2) !== tag);
check("different IPs differ", ipLogTag("203.0.113.8", day1) !== tag);
check("no IP reads none", ipLogTag(null) === "none");

const join = readFileSync("src/lib/interest-list-join.ts", "utf8");
check("interest-list join no longer logs the raw IP", !/ip:\s*ctx\.ip/.test(join) && join.includes("ipLogTag(ctx.ip)"));
const profile = readFileSync("src/lib/extension/parse-profile.ts", "utf8");
check("parse-profile no longer logs model output", !/console\.\w+\([^)]*content\.slice\(/.test(profile));

if (failures) {
  console.error(`\nsmoke-log-hygiene: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-log-hygiene: ok");
process.exit(0);
