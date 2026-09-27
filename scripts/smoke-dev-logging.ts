/**
 * Pins `logging.serverFunctions: false` in next.config.ts (audit B11).
 *
 * Next logs every Server Function call WITH ITS ARGUMENTS in development by default, so
 * saving an AI, Apollo, Resend or Twilio key in Settings printed the key verbatim into the
 * terminal — and into any log a dev session is captured to.
 *
 * Text-level on purpose: importing next.config.ts pulls in Sentry's build wrapper.
 * Pure. Run: npx tsx scripts/smoke-dev-logging.ts
 */
import { readFileSync } from "node:fs";

const src = readFileSync("next.config.ts", "utf8");
const ok = /logging:\s*\{\s*serverFunctions:\s*false\s*,?\s*\}/.test(src);
if (!ok) {
  console.error("  FAIL next.config.ts sets logging.serverFunctions to false");
  process.exit(1);
}
console.log("  ok   next.config.ts sets logging.serverFunctions to false");
process.exit(0);
