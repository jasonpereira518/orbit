/**
 * Asserts that every file under `public/` bypasses the middleware.
 *
 * `proxy.ts`'s matcher excludes static assets by file extension, and anything the list
 * misses goes through `auth.protect()` instead of the static handler. Clerk answers a
 * non-document request with a 404 rather than a redirect, so the asset simply vanishes —
 * for signed-out visitors only. Signed-in ones see it load, and so does every local run,
 * because the middleware skips protection entirely when Clerk is unconfigured. The bug
 * ships looking fine and shows up only on someone else's first visit.
 *
 * That is what happened to `.avif` (Sept 2026): the landing page's `<picture>` elements
 * offer avif first, every modern browser takes it, and a `<source>` that 404s does not
 * fall back to the next one — so all nine planets were missing for anyone without a
 * session, on a page whose entire audience is people without a session.
 *
 * The matcher is read from `src/proxy.ts` rather than duplicated here: Next requires
 * `matcher` values to be statically analysable literals, so there is no shared constant
 * to import and a copy here would drift from the one that actually ships.
 *
 * Run: npx tsx scripts/smoke-static-assets.ts
 */
import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { config } from "../src/proxy";

const PUBLIC_DIR = "public";

/** Every file under `public/`, as the URL path that serves it. */
function publicAssets(dir = PUBLIC_DIR, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...publicAssets(full, `${prefix}/${entry}`));
    } else {
      out.push(`${prefix}/${entry}`);
    }
  }
  return out;
}

/**
 * The exclusion entry, compiled the way Next matches it: anchored at both ends against
 * the request pathname. The other entries (`/(api|trpc)(.*)`, `/__clerk/:path*`) cannot
 * match a `public/` path, so this is the only one that decides an asset's fate.
 */
function exclusionPattern() {
  const [source] = config.matcher;
  if (typeof source !== "string") {
    throw new Error("proxy.ts matcher[0] is not a string — this script needs updating");
  }
  return new RegExp(`^${source}$`);
}

function main() {
  const assets = publicAssets().sort();
  const matcher = exclusionPattern();

  // One asset per extension is enough to prove the rule, and keeps the output readable
  // whatever ends up in `public/`.
  const byExtension = new Map<string, string>();
  for (const asset of assets) {
    const ext = extname(asset).slice(1).toLowerCase() || "(none)";
    if (!byExtension.has(ext)) byExtension.set(ext, asset);
  }

  console.log(`${assets.length} files under ${PUBLIC_DIR}/, ${byExtension.size} extensions\n`);

  const caught: string[] = [];
  for (const [ext, asset] of [...byExtension].sort()) {
    // The middleware runs for a path the matcher matches — which for a static asset is
    // the failure, not the success.
    const runs = matcher.test(asset);
    console.log(`  ${runs ? "FAIL" : "ok  "} .${ext.padEnd(11)} ${asset}`);
    if (runs) caught.push(ext);
  }

  // A path with no static extension must still reach the middleware, or the exclusion has
  // been widened into a hole that lets unauthenticated requests past auth.protect().
  const mustRun = ["/dashboard", "/settings", "/api/contacts"];
  const escaped: string[] = [];
  for (const route of mustRun) {
    const runs = matcher.test(route);
    console.log(`  ${runs ? "ok  " : "FAIL"} ${route} still runs the middleware`);
    if (!runs) escaped.push(route);
  }

  if (caught.length > 0 || escaped.length > 0) {
    if (caught.length > 0) {
      console.error(
        `\nFAILED: ${caught.map((e) => `.${e}`).join(", ")} under public/ is served by the ` +
          `middleware, so it 404s for signed-out visitors.\n` +
          `Add the extension to the matcher's exclusion list in src/proxy.ts.`
      );
    }
    if (escaped.length > 0) {
      console.error(
        `\nFAILED: ${escaped.join(", ")} no longer runs the middleware — the exclusion ` +
          `pattern in src/proxy.ts is letting protected routes through.`
      );
    }
    process.exit(1);
  }

  console.log("\nEvery public/ asset bypasses the middleware.");
}

main();
