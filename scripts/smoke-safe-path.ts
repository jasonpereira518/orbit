/**
 * The one guard behind every "is this a safe app-relative path" decision.
 *
 * Four call sites depend on this predicate, and before it existed there were four
 * hand-maintained copies of the check at three different strengths:
 *
 *   - `safeReturnTo`  (src/lib/connectors/oauth.ts) — correct
 *   - `sanitizePath`  (src/lib/feedback-submission.ts) — missed the folds
 *   - `startGmailOAuth` / `startOutlookOAuth` (src/actions/) — `startsWith("/")` only,
 *     so even a plain protocol-relative `//evil.example` survived
 *
 * The gmail and outlook callbacks resolve their value with `new URL(returnTo, url.origin)`
 * and then `NextResponse.redirect` it, so that weakest copy sat one careless caller away
 * from a live open redirect. Every call site today passes a hardcoded literal, which is the
 * only reason it never was one.
 *
 * Each bypass is asserted against the REAL URL parser as well as against the predicate, so
 * this file cannot rot into agreeing with a broken guard.
 *
 * No database, no network.
 *
 * Run: npx tsx scripts/smoke-safe-path.ts
 */
import { isAppRelativePath } from "../src/lib/safe-path";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/**
 * Strings that a URL parser folds into an authority. The parser folds backslash to forward
 * slash for special schemes, and strips tab/LF/CR from the whole input, both BEFORE it looks
 * for a host — so each of these reaches `evil.example`.
 */
const OFF_ORIGIN = [
  "//evil.example",
  "/\\evil.example",
  "/\\/evil.example",
  "/\t/evil.example",
  "/\n/evil.example",
  "/\r/evil.example",
  "\\\\evil.example",
];

/** Ordinary in-app destinations. Every one of these must survive. */
const APP_PATHS = [
  "/",
  "/imports",
  "/recruiters/compose",
  "/settings/integrations",
  "/contacts/my-contact",
  "/contacts/abc?tab=notes",
  "/a?q=1&r=2",
  "/x.y",
  "/deeply/nested/path/with-hyphens_and_underscores",
];

function main() {
  for (const value of OFF_ORIGIN) {
    const shown = JSON.stringify(value);
    check(`${shown} is rejected`, !isAppRelativePath(value));
    check(
      `  ...and really does resolve off-origin`,
      new URL(value, "https://orbit.test").host === "evil.example"
    );
  }

  console.log("");

  for (const value of APP_PATHS) {
    const shown = JSON.stringify(value);
    check(`${shown} survives`, isAppRelativePath(value));
    check(
      `  ...and really does stay same-origin`,
      new URL(value, "https://orbit.test").origin === "https://orbit.test"
    );
  }

  console.log("");

  // Not paths at all.
  check("a bare word is rejected", !isAppRelativePath("contacts"));
  check("an absolute URL is rejected", !isAppRelativePath("https://evil.test/x"));
  check("a javascript: URL is rejected", !isAppRelativePath("javascript:alert(1)"));
  check("an empty string is rejected", !isAppRelativePath(""));

  // Whitespace and control characters anywhere, not just up front. A real
  // `location.pathname` is percent-encoded and contains none of these, so their presence
  // means the value did not come from where it claims to.
  check("an interior space is rejected", !isAppRelativePath("/a b"));
  check("a NUL is rejected", !isAppRelativePath("/a\u0000b"));
  check("a DEL is rejected", !isAppRelativePath("/a\u007fb"));
  check("a trailing newline is rejected", !isAppRelativePath("/settings\n"));

  console.log("\nAll safe-path checks passed.");
}

main();
process.exit(0);
