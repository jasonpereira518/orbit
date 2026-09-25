/**
 * Which Google/Microsoft sign-ins are free. Connecting to bring in contacts is free on every
 * plan (onboarding walks everyone through it); calendar sync, sending and the inbox scan stay
 * behind the sync entitlement. A source check, because the gate is one line in each action
 * and a refactor could silently put it back in front of everything, or take it off the scan.
 *
 * Run: npx tsx scripts/smoke-connect-gate.ts
 */
import { readFileSync } from "node:fs";

function check(label: string, condition: boolean) {
  if (!condition) throw new Error(`${label} failed`);
  console.log(`  ok  ${label}`);
}

function body(source: string, fn: string): string {
  const start = source.indexOf(`export async function ${fn}(`);
  if (start < 0) throw new Error(`${fn} not found`);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

const guards = readFileSync("src/lib/plan-guards.ts", "utf8");
const connect = body(guards, "requireConnectUser");
check("requireConnectUser skips the sync gate only for contacts", /purpose !== "contacts"\) await requireEntitlement\(userId, "sync"\)/.test(connect));

for (const [file, start, scan] of [
  ["src/actions/gmail.ts", "startGmailOAuth", "startGmailRecruiterScan"],
  ["src/actions/outlook.ts", "startOutlookOAuth", "startOutlookRecruiterScan"],
] as const) {
  const source = readFileSync(file, "utf8");
  const oauth = body(source, start);
  check(`${start} gates by purpose`, oauth.includes("requireConnectUser(input.purpose)") && !oauth.includes("requireSyncUser()"));
  check(`${scan} stays paid`, body(source, scan).includes("requireSyncUser()"));
}

console.log("\nAll connect-gate checks passed.");
process.exit(0);
