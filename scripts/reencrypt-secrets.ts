/**
 * Re-encrypt every stored secret under the current ENCRYPTION_SECRET (see src/lib/crypto-rotation.ts).
 *
 *   ENCRYPTION_PREVIOUS_SECRETS=<old> ENCRYPTION_SECRET=<new> npx tsx scripts/reencrypt-secrets.ts          # dry run
 *   ENCRYPTION_PREVIOUS_SECRETS=<old> ENCRYPTION_SECRET=<new> npx tsx scripts/reencrypt-secrets.ts --apply  # rewrite
 *
 * Targets whatever DATABASE_URL says. Prints counts only, never a value. Exit 1 if any value is
 * opened by no configured secret, so a rotation cannot be finished by mistake.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { reencryptAll } from "../src/lib/crypto-rotation";

async function main() {
  const apply = process.argv.includes("--apply");
  const target = process.env.DATABASE_URL?.trim() ? "DATABASE_URL" : "local PGlite";
  console.log(`reencrypt: ${apply ? "APPLY" : "dry run"} against ${target}`);
  const report = await reencryptAll({ apply });
  console.log(JSON.stringify(report, null, 2));
  if (report.undecryptable > 0) {
    console.error("reencrypt: some values are opened by NO configured secret. Do not remove the old secret.");
    process.exit(1);
  }
  console.log(report.remaining === 0 ? "reencrypt: nothing left under an old secret." : "reencrypt: run again to finish.");
  process.exit(0);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
