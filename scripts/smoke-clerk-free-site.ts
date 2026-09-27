/**
 * Asserts that nothing the Clerk-free pages render can pull client-side Clerk in.
 *
 * The landing page, /interest and the docs live in `src/app/(site)`, outside the
 * ClerkProvider in `src/app/(clerk)/layout.tsx`, so a signed-out stranger downloads no
 * Clerk JS. Measured on production before the move, Clerk was 775+ KB of the landing
 * page's JavaScript. That saving survives only as long as nothing in the pages' import
 * graph imports a client Clerk entry. One `useAuth()` in a shared component would bring
 * it all back, or crash the page, since there is no provider to answer it.
 *
 * Locally there are no Clerk keys, so AuthProvider renders nothing either way and the
 * browser can't show the regression. This walks the source instead: every module
 * reachable from the (site) pages, the root layout that wraps them, and the root
 * not-found / global-error. It resolves `@/` and relative imports and stops at packages.
 *
 * `@clerk/nextjs/server` is allowed: it's server-only and ships nothing to the browser.
 * Type-only imports are skipped for the same reason.
 *
 * Run: npx tsx scripts/smoke-clerk-free-site.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const SITE = join(SRC, "app", "(site)");
const EXTRA_ROOTS = ["layout.tsx", "not-found.tsx", "global-error.tsx"].map((f) =>
  join(SRC, "app", f)
);

/** Client-side Clerk entry points. Anything here ships clerk-js or its UI to the browser. */
function isClientClerk(spec: string) {
  if (spec === "@clerk/nextjs") return true;
  if (spec.startsWith("@clerk/nextjs/")) return !/^@clerk\/nextjs\/(server|webhooks)(\/|$)/.test(spec);
  return /^@clerk\/(ui|react|clerk-react)(\/|$)/.test(spec);
}

const IMPORT_RE =
  /(?:^|[;\n])\s*(import|export)\s+(type\s+)?(?:[^'"`;]*?\sfrom\s*)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiers(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    if (m[2]) continue; // `import type` / `export type` ship no JavaScript
    const spec = m[3] ?? m[4];
    if (spec) out.push(spec);
  }
  return out;
}

const EXTS = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx", "/index.js"];
function resolveLocal(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const ext of EXTS) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

function walkDir(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkDir(full));
    else if (/\.(tsx?|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

function main() {
  const roots = [...walkDir(SITE), ...EXTRA_ROOTS.filter((f) => existsSync(f))];
  const parent = new Map<string, string | null>(roots.map((r) => [r, null]));
  const queue = [...roots];
  const offenders: Array<{ file: string; spec: string }> = [];
  const unresolved: string[] = [];

  while (queue.length) {
    const file = queue.shift()!;
    for (const spec of specifiers(file)) {
      if (isClientClerk(spec)) {
        offenders.push({ file, spec });
        continue;
      }
      if (!spec.startsWith("@/") && !spec.startsWith(".")) continue; // a package: stop here
      const next = resolveLocal(file, spec);
      if (!next) {
        // Assets and CSS resolve to nothing we walk. Anything else is the walker losing its
        // way, which would let the check pass vacuously, so it is reported.
        if (!/\.(css|svg|png|jpe?g|webp|avif|json)$/.test(spec)) unresolved.push(`${relative(ROOT, file)} -> ${spec}`);
        continue;
      }
      if (!parent.has(next)) {
        parent.set(next, file);
        queue.push(next);
      }
    }
  }

  const rel = (f: string) => relative(ROOT, f);
  const chain = (f: string) => {
    const path: string[] = [];
    for (let cur: string | null | undefined = f; cur; cur = parent.get(cur)) path.unshift(rel(cur));
    return path.join("\n        -> ");
  };

  console.log(`Walked ${parent.size} modules from ${roots.length} entry files (src/app/(site) + root layout, not-found, global-error).\n`);

  // Non-vacuity: the walk has to actually reach the modules known to be on these pages.
  // If path resolution silently breaks, the graph collapses to the roots and "no Clerk
  // found" would mean nothing.
  const mustReach = [
    "src/components/landing/landing-page.tsx",
    "src/components/landing/landing-auth-controls.tsx",
    "src/lib/clerk-session-hint.ts",
  ];
  const missed = mustReach.filter((m) => !parent.has(join(ROOT, m)));
  for (const m of mustReach) console.log(`  ${missed.includes(m) ? "FAIL" : "ok  "} reaches ${m}`);

  for (const { file, spec } of offenders) {
    console.log(`\n  FAIL imports "${spec}"\n        ${chain(file)}`);
  }
  for (const u of unresolved) console.log(`  FAIL could not resolve ${u}`);

  if (missed.length || offenders.length || unresolved.length || roots.length === 0) {
    if (offenders.length) {
      console.error(
        `\nFAILED: ${offenders.length} module(s) reachable from the Clerk-free pages import client ` +
          `Clerk. Every signed-out visitor would download clerk-js again, and a Clerk hook would ` +
          `throw, since (site) has no ClerkProvider. Use useClerkSessionHint() ` +
          `(src/lib/clerk-session-hint.ts), or move the page under src/app/(clerk).`
      );
    }
    if (missed.length || roots.length === 0) {
      console.error(`\nFAILED: the walk did not reach modules it must reach, so its "no Clerk" result can't be trusted.`);
    }
    if (unresolved.length) console.error(`\nFAILED: unresolved imports; the walker may be skipping part of the graph.`);
    process.exit(1);
  }
  console.log(`\nNo client Clerk reachable from the Clerk-free pages.`);
  process.exit(0);
}

main();
