/**
 * Production's driver is drizzle's neon-http, which has no interactive transactions:
 * `db.transaction(async …)` throws `No transactions support in neon-http driver` every time,
 * and PGlite (the local and smoke driver) happily runs it, so nothing else catches it.
 * Atomic groups go through `runAtomicWrite` / `runAtomicBatch` in src/db/index.ts, the one
 * file that knows which driver is underneath.
 *
 * Matches `.transaction(async` only. A bare `.transaction(` is also IndexedDB's API
 * (src/lib/meeting-upload-queue.ts) and would false-positive.
 *
 * Pure: reads files. Run: npx tsx scripts/smoke-no-db-transaction.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const OWNER = join("src", "db", "index.ts");
const PATTERN = /\.transaction\(\s*async/;

const offenders = (readdirSync("src", { recursive: true }) as string[])
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .map((f) => join("src", f))
  .filter((f) => f !== OWNER && PATTERN.test(readFileSync(f, "utf8")));

if (offenders.length > 0) {
  console.error(
    `  FAIL interactive db.transaction(async …) outside ${OWNER}; use runAtomicBatch:\n       ${offenders.join("\n       ")}`
  );
  process.exit(1);
}
console.log("  ok   no src/ file but src/db/index.ts opens an interactive transaction");
console.log("\nAll no-db-transaction checks passed.");
