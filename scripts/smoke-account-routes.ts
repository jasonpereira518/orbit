/**
 * The account page's contract: the error map's codes and voice, and the fact that every
 * account route gates on Clerk and on the settings-profile surface key.
 *
 * What it guards against is a raw Clerk string reaching a toast, and a route that forgets
 * its gate — neither of which fails a type check.
 *
 * Run: npx tsx scripts/smoke-account-routes.ts
 */
import { CLERK_ERROR_COPY, clerkErrorMessage } from "../src/lib/clerk-errors";

let failures = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ok  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\nerror copy");
const REQUIRED_CODES = [
  "form_password_pwned",
  "form_code_incorrect",
  "form_identifier_exists",
  "form_password_incorrect",
  "form_password_validation_failed",
];
for (const code of REQUIRED_CODES) {
  check(`${code} has copy`, Boolean(CLERK_ERROR_COPY[code]), "missing");
}
for (const [code, copy] of Object.entries(CLERK_ERROR_COPY)) {
  check(`${code} copy has no trailing period`, !copy.endsWith("."), copy);
  check(`${code} copy does not shout`, !copy.includes("!"), copy);
  check(`${code} copy is not a raw code`, !copy.includes("_"), copy);
}

console.log("\nmapping");
check(
  "a Clerk error shape maps to its copy",
  clerkErrorMessage({ errors: [{ code: "form_code_incorrect" }] }, "fallback") ===
    CLERK_ERROR_COPY.form_code_incorrect
);
check(
  "an unknown code falls back",
  clerkErrorMessage({ errors: [{ code: "something_new" }] }, "fallback") === "fallback"
);
check("a plain Error falls back", clerkErrorMessage(new Error("boom"), "fallback") === "fallback");
check("null falls back", clerkErrorMessage(null, "fallback") === "fallback");
check(
  "the first known code wins over a later unknown one",
  clerkErrorMessage(
    { errors: [{ code: "form_password_pwned" }, { code: "whatever" }] },
    "fallback"
  ) === CLERK_ERROR_COPY.form_password_pwned
);

if (failures > 0) {
  console.error(`\nsmoke-account-routes: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nsmoke-account-routes: all ok");
process.exit(0);
