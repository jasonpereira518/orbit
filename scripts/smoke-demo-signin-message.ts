/**
 * demo-signin-link's "no such user" message names the exact provisioning command, with
 * the same email and Clerk instance, and never echoes the secret key. Pure.
 * Run: npx tsx scripts/smoke-demo-signin-message.ts
 */
import { clerkInstanceLabel, missingDemoUserMessage } from "./lib/demo-account-messages";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const msg = missingDemoUserMessage("demo@orbit.com", "sk_test_SECRETVALUE123");
check("names the instance", msg.includes("Clerk test instance"), msg);
check("gives the exact command", msg.includes("CLERK_SECRET_KEY=sk_test_… npx tsx scripts/provision-demo-account.ts --email demo@orbit.com"), msg);
check("says to re-run", msg.includes("then run this script again"), msg);
check("never prints the secret", !msg.includes("SECRETVALUE123"));
check("live keys are labelled live", clerkInstanceLabel("sk_live_x") === "live");
check("anything else is unknown", clerkInstanceLabel("whatever") === "unknown");
check("an unknown key gets a placeholder, not the key", missingDemoUserMessage("a@b.co", "whatever").includes("CLERK_SECRET_KEY=<your Clerk secret key>"));

if (failures) {
  console.error(`\nsmoke-demo-signin-message: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-demo-signin-message: ok");
process.exit(0);
