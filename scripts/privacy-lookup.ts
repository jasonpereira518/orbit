/**
 * Answer a privacy request from someone who is not an Orbit user: which accounts hold them,
 * and in what kind of record. Counts and account ids only — never the rows' contents.
 *
 *   npx tsx scripts/privacy-lookup.ts --email someone@example.com
 *   npx tsx scripts/privacy-lookup.ts --linkedin https://www.linkedin.com/in/someone
 *
 * Runs against whatever DATABASE_URL resolves to (production, from the operator's machine).
 * It only reads. What to do with the answer is in docs/RUNBOOK.md → "A privacy request from
 * someone who is not a user"; log the request there before running this.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { findPersonAcrossAccounts } from "../src/lib/person-lookup";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function main() {
  const email = arg("email");
  const linkedinUrl = arg("linkedin");
  if (!email && !linkedinUrl) {
    console.error("Usage: tsx scripts/privacy-lookup.ts --email <address> | --linkedin <profile url>");
    process.exit(1);
  }
  const hits = await findPersonAcrossAccounts({ email, linkedinUrl });
  if (hits.length === 0) {
    console.log("Orbit holds no record matching that address or profile.");
    return;
  }
  const accounts = new Set(hits.flatMap((h) => h.accounts));
  console.log(`Found in ${hits.length} kind(s) of record, across ${accounts.size} account(s):\n`);
  for (const hit of hits) {
    console.log(`  ${hit.table}: ${hit.rows} row(s) — ${hit.what}${hit.accounts.length ? ` [${hit.accounts.join(", ")}]` : ""}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
