/**
 * The account page's contract: the error map's codes and voice, and the fact that every
 * account route gates on Clerk and on the settings-profile surface key.
 *
 * What it guards against is a raw Clerk string reaching a toast, and a route that forgets
 * its gate — neither of which fails a type check.
 *
 * Run: npx tsx scripts/smoke-account-routes.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { CLERK_ERROR_COPY, clerkErrorMessage } from "../src/lib/clerk-errors";
import { ACCOUNT_TABS } from "../src/components/account/account-nav";

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
  check(`${code} copy uses typographic apostrophes`, !copy.includes("'"), copy);
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

console.log("\nroutes");
const FILE_FOR_HREF: Readonly<Record<string, string>> = {
  "/settings/account": "src/app/(clerk)/(app)/settings/account/page.tsx",
  "/settings/account/devices": "src/app/(clerk)/(app)/settings/account/devices/page.tsx",
};
for (const tab of ACCOUNT_TABS) {
  const file = FILE_FOR_HREF[tab.href];
  check(`${tab.href} is mapped to a file`, Boolean(file), "add it to FILE_FOR_HREF");
  if (file) check(`${tab.href} has a page`, existsSync(file), file);
}

console.log("\ngating");
const layout = readFileSync("src/app/(clerk)/(app)/settings/account/layout.tsx", "utf8");
check("the shell requires a user", layout.includes("requireUserId"));
check("the shell resolves surface visibility", layout.includes("resolveSurfaceVisibility"));
check(
  "the shell rides the settings-profile key",
  layout.includes('surfaceKeyForSettingsId("settings-profile")')
);
for (const file of Object.values(FILE_FOR_HREF)) {
  if (!existsSync(file)) continue;
  const src = readFileSync(file, "utf8");
  check(`${file} gates on Clerk being configured`, src.includes("isClerkConfigured"));
}

if (failures > 0) {
  console.error(`\nsmoke-account-routes: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nsmoke-account-routes: all ok");
process.exit(0);
