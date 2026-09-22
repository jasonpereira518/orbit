/**
 * Package dist/ for the Chrome Web Store.
 *
 *   npm run zip                        every upload after the first
 *   npm run zip -- --first-upload      the one that creates the store item
 *
 * The store REJECTS a manifest carrying `key` ("The key field is not allowed
 * in the manifest file"), yet the key is what pins the extension ID that Clerk,
 * EXTENSION_ORIGIN and NEXT_PUBLIC_EXTENSION_ID all trust. So dist/ keeps the
 * key (an unpacked load gets the real ID) and the zip drops it. The first
 * upload additionally carries key.pem at the zip root, which is how the store
 * adopts that key — and so that ID — for the new item. After that the store
 * holds the key and key.pem must never be uploaded again.
 *
 * Verify the ID the dashboard shows after the first upload
 * (docs/release-checklist.md): if it isn't the pinned one, stop and follow the
 * checklist before publishing.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

// Unpinned, the store would assign a different ID from the one Clerk and the
// app's EXTENSION_ORIGIN / NEXT_PUBLIC_EXTENSION_ID trust.
if (!parsed.key) {
  console.error("dist/manifest.json has no `key` — VITE_EXTENSION_KEY was not set, so the ID isn't pinned.");
  process.exit(1);
}

// The manifest can be right while the bundle is not: the API base is baked into
// the panel's JS. Every dev origin Orbit builds against carries a port
// (localhost:3000, the e2e builds' 127.0.0.1:9 and localhost:4319); Clerk's own
// chunks mention a bare "http://localhost" with none, which is theirs, not ours.
function jsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return jsFiles(path);
    return name.endsWith(".js") ? [path] : [];
  });
}
const devOrigin = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1):\d+/;
const leaked = jsFiles(join(root, "dist")).filter((file) => devOrigin.test(readFileSync(file, "utf8")));
if (leaked.length) {
  console.error(`A dev origin is baked into ${leaked.length} bundle file(s), e.g. ${leaked[0]} — rebuild with production env.`);
  process.exit(1);
}

const firstUpload = process.argv.includes("--first-upload");
const keyPem = join(root, "key.pem");
if (firstUpload && !existsSync(keyPem)) {
  console.error("--first-upload needs extension/key.pem (the private key behind VITE_EXTENSION_KEY). Run it where that file lives.");
  process.exit(1);
}

// Stage a copy: dist/ itself keeps the key for unpacked loads.
const stage = mkdtempSync(join(tmpdir(), "orbit-zip-"));
execFileSync("cp", ["-R", `${join(root, "dist")}/.`, stage]);
const { key: _pinned, ...storeManifest } = parsed;
writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(storeManifest, null, 2)}\n`);
if (firstUpload) copyFileSync(keyPem, join(stage, "key.pem"));

mkdirSync(join(root, "release"), { recursive: true });
const out = join(root, "release", `orbit-${pkg.version}${firstUpload ? "-FIRST-UPLOAD" : ""}.zip`);
rmSync(out, { force: true });
execFileSync("zip", ["-r", "-q", out, "."], { cwd: stage });
rmSync(stage, { recursive: true, force: true });
console.log(`packaged ${out} (manifest without "key"${firstUpload ? "; key.pem at the root" : ""})`);
if (firstUpload) {
  console.log("This zip contains the PRIVATE key. Upload it once to create the item, then delete it.");
}
