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

const MARKETING_DIR = "src/app/(marketing)";

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
  const guardedOk = leaked.length === 0;

  if (missing.length > 0 || !guardedOk) {
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
    process.exit(1);
  }
  console.log("\nAll marketing routes are publicly reachable.");
}

main();
