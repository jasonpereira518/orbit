/**
 * Every environment variable the app reads is documented in `.env.example`, and so is every
 * name `src/lib/env.ts` requires or expects in production. A variable read by code and
 * mentioned nowhere is how Eventbrite connect failed at OAuth start with nothing to say why.
 *
 * Pure: reads files only. Run: npx tsx scripts/smoke-env-documented.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EXPECTED_IN_PRODUCTION, REQUIRED_IN_PRODUCTION } from "../src/lib/env";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

/** Set by Vercel, Next, the harness or next.config.ts — never by hand, so never documented. */
const PLATFORM_INJECTED = new Set([
  "NODE_ENV", "NEXT_RUNTIME", "NEXT_PHASE", "PORT", "CI", "BUILD_TIME",
  "VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_GIT_COMMIT_SHA", "VERCEL_DEPLOYMENT_ID",
  "VERCEL_PROJECT_PRODUCTION_URL", "NEXT_PUBLIC_VERCEL_ENV", "ORBIT_PGLITE_DIR", "SMOKE_ALLOW_REMOTE",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

const readBy = new Map<string, string>();
for (const file of walk("src")) {
  for (const m of readFileSync(file, "utf8").matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) {
    if (!readBy.has(m[1])) readBy.set(m[1], file);
  }
}
const documented = new Set(
  [...readFileSync(".env.example", "utf8").matchAll(/^#?\s*([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1])
);

console.log(`Variables read in src/: ${readBy.size}; documented in .env.example: ${documented.size}`);
const undocumented = [...readBy.entries()].filter(([name]) => !documented.has(name) && !PLATFORM_INJECTED.has(name));
check("every variable src/ reads is in .env.example (or platform-injected)", undocumented.length === 0,
  undocumented.map(([name, file]) => `${name} (read in ${file})`).join("\n       "));
const contract = [...REQUIRED_IN_PRODUCTION, ...EXPECTED_IN_PRODUCTION].filter((n) => !documented.has(n));
check("every REQUIRED/EXPECTED production variable is documented", contract.length === 0, contract.join(", "));

// (doc checks go above this line)

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll env-documentation checks passed.");
