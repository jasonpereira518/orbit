/**
 * The account page's contract: the error map's codes and voice, and the fact that every
 * account route gates on Clerk and on the settings-profile surface key.
 *
 * What it guards against is a raw Clerk string reaching a toast, a route that forgets its
 * gate, and the loss of the only way to sign out — none of which fails a type check.
 *
 * Run: npx tsx scripts/smoke-account-routes.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLERK_ERROR_COPY, clerkErrorMessage } from "../src/lib/clerk-errors";
import { ACCOUNT_TABS } from "../src/components/account/account-nav";
import { surfaceKeyForSettingsId } from "../src/lib/surfaces";

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
const FILE_FOR_HREF: Readonly<Record<string, string>> = {
  "/settings/account": "src/app/(clerk)/(app)/settings/account/page.tsx",
  "/settings/account/sign-in": "src/app/(clerk)/(app)/settings/account/sign-in/page.tsx",
  "/settings/account/sign-in/callback":
    "src/app/(clerk)/(app)/settings/account/sign-in/callback/page.tsx",
  "/settings/account/devices": "src/app/(clerk)/(app)/settings/account/devices/page.tsx",
};
for (const tab of ACCOUNT_TABS) {
  const file = FILE_FOR_HREF[tab.href];
  check(`${tab.href} is mapped to a file`, Boolean(file), "add it to FILE_FOR_HREF");
  if (file) check(`${tab.href} has a page`, existsSync(file), file);
}

console.log("\ngating");

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

const layout = code("src/app/(clerk)/(app)/settings/account/layout.tsx");
// Call shapes, not bare identifiers: `layout.includes("requireUserId")` also passed when the
// gate was nothing but an unused import, and both of these gates are the whole reason this
// file exists.
check("the shell awaits a user id", /await requireUserId\(\)/.test(layout));
check(
  "the shell awaits surface visibility",
  /await resolveSurfaceVisibility\(/.test(layout)
);
check(
  "the shell rides the settings-profile key",
  layout.includes('surfaceKeyForSettingsId("settings-profile")')
);
check(
  "a hidden viewer is sent back to /settings",
  /redirect\("\/settings"\)/.test(layout)
);
// The key itself has to resolve: renaming the settings id would leave the line above
// matching while the predicate compared against nothing.
check(
  "settings-profile resolves to a surface key",
  Boolean(surfaceKeyForSettingsId("settings-profile")),
  "surfaceKeyForSettingsId returned nothing"
);
for (const file of Object.values(FILE_FOR_HREF)) {
  if (!existsSync(file)) continue;
  check(`${file} gates on Clerk being configured`, code(file).includes("isClerkConfigured"));
}

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
