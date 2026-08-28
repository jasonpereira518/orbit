/** Package dist/ for the Chrome Web Store. */
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// Chrome rejects semver prerelease tags — the version must be plain x.y.z.
if (!/^\d+(\.\d+){0,3}$/.test(pkg.version)) {
  console.error(`Invalid extension version "${pkg.version}" — use plain x.y.z.`);
  process.exit(1);
}

mkdirSync(join(root, "release"), { recursive: true });
const out = join(root, "release", `orbit-${pkg.version}.zip`);
execFileSync("zip", ["-r", "-q", out, "."], { cwd: join(root, "dist") });
console.log(`packaged ${out}`);
