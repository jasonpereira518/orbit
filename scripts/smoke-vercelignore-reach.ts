/**
 * Everything the production build type-checks must exist in the deployment. `.vercelignore`
 * drops the browser extension (it is built and published separately), but `typecheck:fast`
 * runs over every script, so a script or source file that imports from `extension/` fails the
 * Vercel build with "Cannot find module" — while the full checkout CI runs from still passes.
 * That is how a smoke test that imported the LinkedIn scan adapter broke production.
 *
 * Reads files only. For each relative import that lands in the root `extension/` folder, the
 * file must not be ignored by `.vercelignore`.
 * Run: npx tsx scripts/smoke-vercelignore-reach.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import { checker } from "./smoke/check";

const t = checker();
const root = process.cwd();
const ignored = ignore().add(readFileSync(join(root, ".vercelignore"), "utf8"));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(path);
  }
  return out;
}

const IMPORT = /(?:from\s*|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g;
const EXTENSIONS = ["", ".ts", ".tsx", ".mts", "/index.ts", "/index.tsx"];

const reached = new Map<string, string[]>();
for (const file of [...walk(join(root, "src")), ...walk(join(root, "scripts"))]) {
  const source = readFileSync(file, "utf8");
  for (const [, spec] of source.matchAll(IMPORT)) {
    const base = resolve(dirname(file), spec);
    const rel = relative(root, base);
    if (rel !== "extension" && !rel.startsWith(`extension${sep}`)) continue;
    const target = EXTENSIONS.map((ext) => base + ext).find((p) => existsSync(p) && statSync(p).isFile());
    const key = relative(root, target ?? base).split(sep).join("/");
    reached.set(key, [...(reached.get(key) ?? []), relative(root, file)]);
  }
}

t.check("the ignore rules load", ignored.ignores("extension/package.json"));
t.check("the extension is still kept out of the deployment", ignored.ignores("extension/src/background/index.ts"));
for (const [target, importers] of reached) {
  t.check(`${target} ships with the deployment (imported by ${importers.join(", ")})`, !ignored.ignores(target));
}
t.check("src/lib/extension is not caught by the extension rule", !ignored.ignores("src/lib/extension/auth.ts"));
t.done("vercelignore reach smoke tests");
