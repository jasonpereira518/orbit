/**
 * Build-time environment gate. Runs in the Vercel build command ahead of `next build`, so
 * a deploy missing something production requires fails BEFORE it is aliased and the last
 * good deployment stays live. Prints names only, never values.
 *
 * Run: npx tsx scripts/check-env.ts
 */
import { getEnvReport } from "../src/lib/env";

const report = getEnvReport();
const env = process.env.VERCEL_ENV ?? "local";

for (const w of report.warnings) console.warn(`  warn  ${w}`);
if (report.errors.length > 0) {
  for (const e of report.errors) console.error(`  ERROR ${e}`);
  console.error(`\ncheck-env: ${report.errors.length} error(s) for VERCEL_ENV=${env}. Refusing to build.`);
  process.exit(1);
}
console.log(`check-env: ok for VERCEL_ENV=${env} (${report.warnings.length} warning(s))`);
process.exit(0);
