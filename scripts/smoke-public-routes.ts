/**
 * Asserts that every page under `src/app/(marketing)/` is reachable without signing in.
 *
 * This exists because the failure mode is invisible in development: `proxy.ts` only calls
 * `auth.protect()` when Clerk is configured, so locally (no keys) every route returns 200
 * and a missing entry looks fine. In production the same page 404s for every signed-out
 * visitor — which, for marketing pages, is the entire audience.
 *
 * Run: npx tsx scripts/smoke-public-routes.ts
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRouteMatcher } from "@clerk/nextjs/server";
import { PUBLIC_ROUTES } from "../src/lib/public-routes";
import { config as proxyConfig } from "../src/proxy";

const MARKETING_DIR = "src/app/(marketing)";
const PUBLIC_DIR = "public";

/** Every distinct file extension actually shipped in `public/`. */
function publicAssetExtensions(dir = PUBLIC_DIR): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full, `${prefix}/${entry}`);
        continue;
      }
      const ext = entry.includes(".") ? entry.split(".").pop()! : "";
      // Remember one real example path per extension so a failure names a real file.
      if (ext && !found.has(ext)) found.set(ext, `${prefix}/${entry}`);
    }
  };
  walk(dir, "");
  return found;
}

/**
 * The matcher entry whose negative lookahead lists the static extensions middleware skips.
 * Next compiles these entries as regexes, so testing it the same way is faithful.
 */
const exclusionEntry = proxyConfig.matcher.find((m) => m.includes("_next"))!;
const exclusionRe = new RegExp(`^${exclusionEntry}$`);

/** Every route a `page.tsx` under the marketing group serves, as a URL path. */
function marketingRoutes(dir = MARKETING_DIR, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Route groups like (marketing) contribute no path segment.
      const segment = entry.startsWith("(") && entry.endsWith(")") ? "" : `/${entry}`;
      out.push(...marketingRoutes(full, prefix + segment));
    } else if (entry === "page.tsx") {
      out.push(prefix === "" ? "/" : prefix);
    }
  }
  return out;
}

const isPublic = createRouteMatcher([...PUBLIC_ROUTES]);

// The matcher only reads `req.nextUrl.pathname`, so a stub is enough and avoids
// constructing a full NextRequest outside a server runtime.
const check = (path: string) =>
  isPublic({ nextUrl: { pathname: path } } as Parameters<typeof isPublic>[0]);

function main() {
  const routes = marketingRoutes().sort();
  console.log(`Marketing routes found: ${routes.join(", ")}\n`);

  const missing: string[] = [];
  for (const route of routes) {
    const ok = check(route);
    console.log(`  ${ok ? "ok  " : "FAIL"} ${route} ${ok ? "is public" : "is NOT public"}`);
    if (!ok) missing.push(route);
  }

  // Routes that must stay behind auth. `/upgrade` is the important one: it is a purchase
  // page in the same visual world as the marketing site, so it is easy to mistake for
  // another marketing page and make public — but checkout needs a user to attribute the
  // payment to.
  const mustBeGuarded = ["/dashboard", "/upgrade", "/settings"];
  const leaked: string[] = [];
  for (const route of mustBeGuarded) {
    const ok = !check(route);
    console.log(`  ${ok ? "ok  " : "FAIL"} ${route} stays protected`);
    if (!ok) leaked.push(route);
  }
  // Internal job routes. Vercel Cron, the ops scheduler and the app's own self-continuation
  // `fetch` carry no Clerk session, so these must be exempt from `auth.protect()` — they
  // authenticate with CRON_SECRET via `isInternalRequest()` instead. One missing here means
  // the cron never runs and a long import cannot continue, and it only shows in production.
  const internalRoutes = [
    "/api/imports/process-stalled",
    "/api/imports/imp_abc123/continue",
    "/api/embeddings/backfill",
    "/api/linkedin/timeline-events/backfill",
    "/api/ops/sweep",
    // The uptime monitor has no session either.
    "/api/health",
    // Browsers report CSP violations without one.
    "/api/csp-report",
  ];
  const blocked: string[] = [];
  for (const route of internalRoutes) {
    const ok = check(route);
    console.log(`  ${ok ? "ok  " : "FAIL"} ${route} ${ok ? "is exempt from Clerk" : "is behind Clerk"}`);
    if (!ok) blocked.push(route);
  }

  // Static assets in public/. `proxy.ts`'s matcher skips middleware for a fixed list of
  // extensions; anything missing from that list is matched, fails isPublicRoute and gets a
  // 307 to /sign-in instead of its bytes. Invisible in dev for the same reason as above,
  // and for a <picture> it is unrecoverable — once a <source> matches by type the browser
  // commits to that URL and never falls back to the <img>. That is how `avif` blanked every
  // planet on the marketing hero while the .png and .webp siblings served fine.
  console.log("");
  const assets = publicAssetExtensions();
  const gated: string[] = [];
  for (const [ext, example] of [...assets].sort()) {
    const ok = !exclusionRe.test(example);
    console.log(`  ${ok ? "ok  " : "FAIL"} .${ext} bypasses middleware (${example})`);
    if (!ok) gated.push(`.${ext} (e.g. ${example})`);
  }

  const guardedOk = leaked.length === 0;

  if (gated.length > 0) {
    console.error(
      `\nFAILED: ${gated.join(", ")} in public/ is matched by the proxy matcher, so it will` +
        ` 307 to /sign-in in production instead of serving. Add the extension to the` +
        ` negative lookahead in src/proxy.ts.`
    );
  }

  if (missing.length > 0 || !guardedOk || blocked.length > 0 || gated.length > 0) {
    if (missing.length > 0) {
      console.error(
        `\nFAILED: add ${missing.join(", ")} to PUBLIC_ROUTES in src/lib/public-routes.ts`
      );
    }
    if (leaked.length > 0) {
      console.error(
        `\nFAILED: ${leaked.join(", ")} must NOT be in PUBLIC_ROUTES — they require a session`
      );
    }
    if (blocked.length > 0) {
      console.error(
        `\nFAILED: ${blocked.join(", ")} must be in PUBLIC_ROUTES — cron and self-continuation calls carry no Clerk session`
      );
    }
    process.exit(1);
  }
  console.log("\nAll marketing routes are publicly reachable.");
}

main();
