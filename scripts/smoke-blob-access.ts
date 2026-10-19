/**
 * Every object Orbit stores in Vercel Blob is private, unless it is on the short list below
 * with a reason it must be public.
 *
 * Capture photos (pictures of notes and business cards) and feedback screenshots used to be
 * public objects behind an unguessable URL (PRIVACY_AUDIT.md F-17). They are private now and
 * served only through owner-checked routes (src/lib/stored-blob.ts). This scans every `put(`
 * call in src/ so a new public upload cannot appear without an entry here.
 *
 * Pure: reads source files only. Run: npx tsx scripts/smoke-blob-access.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isPublicBlobUrl } from "../src/lib/stored-blob";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Files allowed to upload public objects, and why. */
const PUBLIC_ALLOWED: Record<string, string> = {
  "src/lib/avatar-blob.ts": "contact photos are rendered directly by <img> across the app; the per-account ones sit behind a random suffix and the owner-checked /api/avatars route",
  "src/lib/events/cover.ts": "event cover images are the event's own public promotional artwork",
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

console.log("Blob uploads");
for (const file of files("src")) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/\bput\(/g)) {
    const window = text.slice(m.index!, m.index! + 600);
    if (!/access\s*:/.test(window)) continue; // not a Blob put
    const line = text.slice(0, m.index).split("\n").length;
    const isPublic = /access\s*:\s*"public"/.test(window);
    if (isPublic) check(`${file}:${line} is public — ${PUBLIC_ALLOWED[file] ?? "NOT ALLOWED"}`, Boolean(PUBLIC_ALLOWED[file]));
    else check(`${file}:${line} is private`, true);
  }
}
for (const file of ["src/lib/capture-photos.ts", "src/lib/feedback-submission.ts"]) {
  check(`${file} stores private objects`, /access:\s*PRIVATE_BLOB_ACCESS/.test(readFileSync(file, "utf8")));
}

console.log("\nReading back");
check("a public URL is recognised (older rows)", isPublicBlobUrl("https://abc.public.blob.vercel-storage.com/capture-photos/x.jpg"));
check("a private URL is not", !isPublicBlobUrl("https://abc.private.blob.vercel-storage.com/capture-photos/x.jpg"));
for (const route of ["src/app/api/capture/photos/[photoId]/route.ts", "src/app/api/feedback/screenshots/[shotId]/route.ts"]) {
  const text = readFileSync(route, "utf8");
  check(`${route} reads through readStoredBlob`, text.includes("readStoredBlob(") && !/fetch\([^)]*[bB]lobUrl/.test(text));
}

if (failures > 0) {
  console.error(`\n${failures} blob-access check(s) failed`);
  process.exit(1);
}
console.log("\nAll blob-access checks passed.");
