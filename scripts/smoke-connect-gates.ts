/**
 * Which plan gate each connect and scan action uses, read from the source with the TypeScript
 * compiler rather than by calling them (they need a request and a signed-in user).
 *
 * The spec makes Google and Microsoft free and keeps the recruiter inbox scan on Pro, so a
 * `requireSyncUser` creeping back into a connect action is a paywall nobody meant to ship —
 * and a scan action losing its gate gives the feature away.
 *
 * `callsIn` is also imported by other smoke scripts (task 6), which is why the check-running
 * section below is guarded behind a direct-execution check rather than running at module top
 * level: an importer must be able to reach `callsIn` without also running this file's own
 * checks and `process.exit`.
 *
 * Run: npx tsx scripts/smoke-connect-gates.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { friendlyError } from "../src/lib/errors";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Every identifier called inside the named exported function. */
export function callsIn(file: string, fn: string): Set<string> {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const calls = new Set<string>();
  let found = false;
  const walk = (node: ts.Node, inside: boolean) => {
    const here =
      inside ||
      (ts.isFunctionDeclaration(node) && node.name?.text === fn) ||
      ((ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === fn));
    if (here && !inside) found = true;
    if (here && ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.add(node.expression.text);
    ts.forEachChild(node, (child) => walk(child, here));
  };
  ts.forEachChild(source, (node) => walk(node, false));
  if (!found) throw new Error(`${fn} not found in ${file}`);
  return calls;
}

function main() {
  // Resolved from this file's own URL, not the working directory, so `callsIn`'s callers and
  // this script's own checks both find the right files whichever directory `tsx` is run from.
  const GMAIL = fileURLToPath(new URL("../src/actions/gmail.ts", import.meta.url));
  const OUTLOOK = fileURLToPath(new URL("../src/actions/outlook.ts", import.meta.url));

  console.log("connecting is free");
  for (const [file, fn] of [[GMAIL, "startGmailOAuth"], [OUTLOOK, "startOutlookOAuth"]] as const) {
    const calls = callsIn(file, fn);
    check(`${fn} asks only for a signed-in user`, calls.has("requireUserId"));
    check(`${fn} has no paid-plan gate`, !calls.has("requireSyncUser"));
  }

  console.log("\nthe inbox scan stays paid");
  for (const [file, fn] of [
    [GMAIL, "startGmailRecruiterScan"],
    [GMAIL, "cancelGmailRecruiterScan"],
    [OUTLOOK, "startOutlookRecruiterScan"],
    [OUTLOOK, "cancelOutlookRecruiterScan"],
  ] as const) {
    const calls = callsIn(file, fn);
    check(`${fn} requires the recruiters plan`, calls.has("requireRecruitersUser"));
    check(`${fn} no longer uses the sync gate`, !calls.has("requireSyncUser"));
  }

  console.log("\nthe paywall message reaches the person");
  // Built inline rather than imported from `src/lib/entitlements` — this smoke is `pure` tier,
  // and that module can pull the database module in. `friendlyError` matches on `name`, not
  // `instanceof`, so this exercises the real branch without the import.
  const denial = Object.assign(new Error("Recruiter tracking is available on Orbit Pro and Orbit Lifetime."), {
    name: "PaywallError",
  });
  check("friendlyError shows it verbatim", friendlyError(denial, "Couldn’t do that — try again?") === denial.message);
  check("an ordinary error still falls back", friendlyError(new Error("ECONNRESET"), "Couldn’t do that — try again?") === "Couldn’t do that — try again?");

  if (failures > 0) {
    console.error(`\nsmoke-connect-gates: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nsmoke-connect-gates: all ok");
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
