/**
 * The account experience's contract: the error map's codes and voice, the fact that the
 * account dialog's rail still carries all four sections, and the fact that the one account
 * route that must survive being a dialog — the OAuth return leg — still gates on Clerk.
 *
 * What it guards against is a raw Clerk string reaching a toast, the callback route losing
 * its gate, a rail section silently dropped, and the loss of the only way to sign out — none
 * of which fails a type check.
 *
 * The account experience moved from routes to a dialog on 2026-09-23 (see the amendment in
 * docs/superpowers/specs/2026-09-22-account-page-clerk-revision-design.md); this smoke moved
 * with it. Its old route table and layout-gating checks are gone along with the files they
 * asserted — `src/components/account/account-dialog.tsx` is the new source of truth.
 *
 * Run: npx tsx scripts/smoke-account-routes.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLERK_ERROR_COPY, clerkErrorMessage } from "../src/lib/clerk-errors";

let failures = 0;

/** Every .ts/.tsx file under `dir`. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

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

/**
 * Source with comments removed, so a check cannot pass on a line that no longer runs.
 * `scripts/smoke-schema-ddl.ts` learned this the hard way: a regex over raw source happily
 * matched commented-out code. Strings are left alone — every pattern below is a call shape,
 * not a string literal.
 */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

// The four human-facing routes are gone — the dialog replaced them. What must not come back
// is a page at any of their paths (a merge conflict or a stray revert is the realistic way
// one would), and what must not disappear is the one route a browser navigation genuinely
// has to land on: the OAuth return leg, which a dialog cannot receive.
const REMOVED_ROUTE_FILES = [
  "src/app/(clerk)/(app)/settings/account/layout.tsx",
  "src/app/(clerk)/(app)/settings/account/page.tsx",
  "src/app/(clerk)/(app)/settings/account/sign-in/page.tsx",
  "src/app/(clerk)/(app)/settings/account/devices/page.tsx",
];
for (const file of REMOVED_ROUTE_FILES) {
  check(`${file} stays deleted`, !existsSync(file));
}

const CALLBACK_FILE = "src/app/(clerk)/(app)/settings/account/sign-in/callback/page.tsx";
check("the callback route still exists", existsSync(CALLBACK_FILE), CALLBACK_FILE);
if (existsSync(CALLBACK_FILE)) {
  check(
    `${CALLBACK_FILE} gates on Clerk being configured`,
    code(CALLBACK_FILE).includes("isClerkConfigured")
  );
}

console.log("\naccount dialog");
const dialogFile = "src/components/account/account-dialog.tsx";
const dialog = code(dialogFile);
check(`${dialogFile} exists`, existsSync(dialogFile));
// The rail order the spec fixes: Profile, Sign-in, Security, Devices. Checked by position,
// not just presence, so a reorder — not only a dropped section — fails this.
const RAIL_LABELS = ["Profile", "Sign-in", "Security", "Devices"];
const positions = RAIL_LABELS.map((label) => dialog.indexOf(`label: "${label}"`));
for (const [i, label] of RAIL_LABELS.entries()) {
  check(`account dialog rail has ${label}`, positions[i] !== -1, "missing from ACCOUNT_SECTIONS");
}
check(
  "the four rail sections are in the required order",
  positions.every((p) => p !== -1) && positions.every((p, i) => i === 0 || p > positions[i - 1]),
  positions.join(",")
);
check("the dialog gates its sections on clerkOn", dialog.includes("clerkOn"));

/**
 * The sign-out invariant, which is the one failure in this feature nobody could work around:
 * Clerk's `UserButton` popover was the only way out of the app, and this branch removed it.
 * A release where the menu has lost its `SignOutButton` — or where a Clerk account component
 * has crept back in beside Orbit's own screens — is a release where nobody can sign out, or
 * two rival account UIs. Neither fails a type check.
 */
console.log("\nsign-out and Clerk components");
const SRC_FILES = walk("src");
const MENU = "src/components/account/account-menu.tsx";
const menu = code(MENU);
check("the account menu imports SignOutButton from Clerk", /import\s*\{[^}]*\bSignOutButton\b[^}]*\}\s*from\s*["']@clerk\/nextjs["']/.test(menu));
check("the account menu renders it", /<SignOutButton[\s>]/.test(menu));

const BANNED_CLERK_COMPONENTS = ["UserButton", "UserProfile"];
const offenders: string[] = [];
for (const file of SRC_FILES) {
  const src = code(file);
  for (const m of src.matchAll(
    /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'](@clerk\/[^"']+)["']/g
  )) {
    const named = m[1]
      .split(",")
      .map((part) => part.split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    for (const banned of BANNED_CLERK_COMPONENTS) {
      if (named.includes(banned)) offenders.push(`${file} imports ${banned} from ${m[2]}`);
    }
  }
  // Only in .tsx, and only where the `<` opens a tag rather than a type argument: Orbit has
  // its own `UserProfile` TYPE (src/lib/auth.ts), so `Promise<UserProfile | null>` must not
  // read as a rendered Clerk component. Requiring a non-identifier character before the `<`
  // is what separates the two.
  if (!file.endsWith(".tsx")) continue;
  for (const banned of BANNED_CLERK_COMPONENTS) {
    if (new RegExp(`(^|[\\s(){},=>])<${banned}[\\s/>]`, "m").test(src)) {
      offenders.push(`${file} renders <${banned}>`);
    }
  }
}
check(
  "no Clerk UserButton or UserProfile anywhere in src",
  offenders.length === 0,
  offenders.join("; ")
);

if (failures > 0) {
  console.error(`\nsmoke-account-routes: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nsmoke-account-routes: all ok");
process.exit(0);
