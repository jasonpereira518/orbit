/**
 * Asserts `hasClerkSessionHint` reads Clerk's `__client_uat` cookie the way Clerk writes it.
 *
 * The marketing pages decide between "Sign in / Get Started" and "Open app" from this one
 * function, because they mount no ClerkProvider. Clerk writes `"0"` for a signed-out
 * client and a Unix timestamp otherwise, and current Clerk adds a suffixed twin keyed to
 * the publishable key. Getting any of that wrong shows signed-in people the sign-up pitch,
 * or strangers an "Open app" button that bounces them to sign-in.
 *
 * Run: npx tsx scripts/smoke-clerk-session-hint.ts
 */
import { hasClerkSessionHint } from "../src/lib/clerk-session-hint";

const CASES: Array<[label: string, cookie: string, expected: boolean]> = [
  ["no cookies at all", "", false],
  ["unrelated cookies only", "theme=dark; orbit_attr=abc", false],
  ["signed out: __client_uat=0", "__client_uat=0", false],
  ["signed in: __client_uat=<timestamp>", "__client_uat=1757462400", true],
  ["signed in, among other cookies", "theme=dark; __client_uat=1757462400; x=1", true],
  ["suffixed variant signed in", "__client_uat_Qm9vc3Rz=1757462400", true],
  ["suffixed variant signed out", "__client_uat_Qm9vc3Rz=0", false],
  ["suffixed 0 beside unsuffixed timestamp", "__client_uat_Qm9vc3Rz=0; __client_uat=1757462400", true],
  ["both zero", "__client_uat=0; __client_uat_Qm9vc3Rz=0", false],
  ["malformed value", "__client_uat=yes", false],
  ["negative value", "__client_uat=-5", false],
  ["empty value", "__client_uat=", false],
  ["a lookalike name is not the cookie", "my__client_uat=1757462400; __client_uatx=1757462400", false],
  ["no '=' at all", "__client_uat", false],
  ["whitespace around the pair", "  __client_uat = 1757462400 ", true],
];

let failed = 0;
for (const [label, cookie, expected] of CASES) {
  const got = hasClerkSessionHint(cookie);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(42)} -> ${got}${ok ? "" : ` (expected ${expected})`}`);
}

if (failed > 0) {
  console.error(`\nFAILED: ${failed} case(s). See src/lib/clerk-session-hint.ts.`);
  process.exit(1);
}
console.log(`\nAll ${CASES.length} cookie cases read the way Clerk writes them.`);
process.exit(0);
