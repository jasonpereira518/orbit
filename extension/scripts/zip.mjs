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

// A zip that would embarrass us on the store shelf: refuse a dev-named build
// or one still carrying localhost anywhere in its manifest.
const manifest = readFileSync(join(root, "dist", "manifest.json"), "utf8");
const parsed = JSON.parse(manifest);
if (parsed.name !== "Orbit") {
  console.error(`dist/manifest.json name is "${parsed.name}" — rebuild in production mode.`);
  process.exit(1);
}
if (/localhost|127\.0\.0\.1/.test(manifest)) {
  console.error("dist/manifest.json contains a localhost reference — rebuild with production env.");
  process.exit(1);
}

mkdirSync(join(root, "release"), { recursive: true });
const out = join(root, "release", `orbit-${pkg.version}.zip`);
execFileSync("zip", ["-r", "-q", out, "."], { cwd: join(root, "dist") });
console.log(`packaged ${out}`);
