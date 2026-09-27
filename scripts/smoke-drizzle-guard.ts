/**
 * `drizzle-kit push` computes DROPs for everything Orbit manages outside schema.ts
 * (embedding_vector, the HNSW index, the migration tables). The config refuses it unless
 * explicitly allowed and pointed away from production.
 *
 * Pure: the subprocess check targets 127.0.0.1:1, where nothing listens, and the guard
 * refuses before any connection. Run: npx tsx scripts/smoke-drizzle-guard.ts
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { checkDrizzleCommand } from "../src/lib/env";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const PROD = "ep-prod-1234.us-east-2.aws.neon.tech";
const BRANCH = "ep-branch-5678.us-east-2.aws.neon.tech";
const url = (host: string) => `postgres://u:secret@${host}/orbit?sslmode=require`;
const argv = (cmd: string) => ["/usr/bin/node", "/x/node_modules/drizzle-kit/bin.cjs", cmd];

check("generate is always allowed", checkDrizzleCommand(argv("generate"), {}).allowed);
check("studio is always allowed", checkDrizzleCommand(argv("studio"), { DATABASE_URL: url(PROD), PRODUCTION_DB_HOST: PROD }).allowed);
const noConsent = checkDrizzleCommand(argv("push"), { DATABASE_URL: url(BRANCH), PRODUCTION_DB_HOST: PROD });
check("push without ALLOW_DRIZZLE_PUSH=1 is refused, naming the variable",
  !noConsent.allowed && noConsent.reason.includes("ALLOW_DRIZZLE_PUSH"), noConsent.reason);
const atProd = checkDrizzleCommand(argv("push"), { ALLOW_DRIZZLE_PUSH: "1", DATABASE_URL: url(PROD), PRODUCTION_DB_HOST: PROD });
check("push at the production host is refused even with consent", !atProd.allowed && atProd.reason.includes(PROD), atProd.reason);
check("the refusal never prints the password", !atProd.reason.includes("secret"));
check("push with PRODUCTION_DB_HOST unset is refused (cannot tell)",
  !checkDrizzleCommand(argv("push"), { ALLOW_DRIZZLE_PUSH: "1", DATABASE_URL: url(BRANCH) }).allowed);
check("migrate and drop are guarded the same way",
  !checkDrizzleCommand(argv("migrate"), {}).allowed && !checkDrizzleCommand(argv("drop"), {}).allowed);
check("push with consent at a non-production host is allowed",
  checkDrizzleCommand(argv("push"), { ALLOW_DRIZZLE_PUSH: "1", DATABASE_URL: url(BRANCH), PRODUCTION_DB_HOST: PROD }).allowed);

console.log("\nThe real CLI, through drizzle.config.ts...");
const r = spawnSync(process.execPath, [join("node_modules", "drizzle-kit", "bin.cjs"), "push"], {
  env: { ...process.env, ALLOW_DRIZZLE_PUSH: "", DATABASE_URL: "postgres://u:p@127.0.0.1:1/none", PRODUCTION_DB_HOST: PROD },
  encoding: "utf8",
  timeout: 60_000,
});
check("drizzle-kit push exits nonzero", r.status !== 0, `status ${r.status}`);
check("because the config refused it", `${r.stdout}${r.stderr}`.includes("ALLOW_DRIZZLE_PUSH"), `${r.stdout}${r.stderr}`.slice(0, 400));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll drizzle-guard checks passed.");
process.exit(0);
