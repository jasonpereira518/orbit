/**
 * The plan card never says "Unlimited contacts" beside "Up to 500 contacts" without saying
 * why: a demo account names the exemption. Pure (env toggles only).
 * Run: npx tsx scripts/smoke-plan-card-copy.ts
 */
import { demoAccountReason, isDemoAccount } from "../src/lib/demo-account";
import { unlimitedContactsLine } from "../src/lib/plan-copy";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const env = process.env as Record<string, string | undefined>;
const prior = { node: env.NODE_ENV, showcase: env.DEMO_ACCOUNT_USER_ID };
try {
  env.NODE_ENV = "development";
  delete env.DEMO_ACCOUNT_USER_ID;
  check("any account on localhost is a localhost demo", demoAccountReason("user_real") === "localhost");
  check("no user, no reason", demoAccountReason(null) === null);
  env.NODE_ENV = "production";
  env.DEMO_ACCOUNT_USER_ID = "user_showcase";
  check("the showcase account off localhost", demoAccountReason("user_showcase") === "showcase");
  check("anyone else off localhost is not a demo", demoAccountReason("user_real") === null);
  for (const id of ["user_showcase", "user_real", null]) {
    check(`isDemoAccount agrees for ${id}`, isDemoAccount(id) === (demoAccountReason(id) !== null));
  }
} finally {
  if (prior.node === undefined) delete env.NODE_ENV; else env.NODE_ENV = prior.node;
  if (prior.showcase === undefined) delete env.DEMO_ACCOUNT_USER_ID; else env.DEMO_ACCOUNT_USER_ID = prior.showcase;
}

check("localhost wording", unlimitedContactsLine(12, "localhost") === "Demo account — plan limits lifted on localhost. 12 in your orbit.", unlimitedContactsLine(12, "localhost"));
check("showcase wording", unlimitedContactsLine(3, "showcase") === "Showcase account — plan limits lifted. 3 in your orbit.");
check("a real unlimited plan keeps its line", unlimitedContactsLine(40, null) === "Unlimited contacts — 40 in your orbit.");

if (failures) {
  console.error(`\nsmoke-plan-card-copy: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-plan-card-copy: ok");
process.exit(0);
