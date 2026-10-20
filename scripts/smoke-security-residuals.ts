/**
 * Source-level guards for three audit residuals that no runtime test reaches cheaply:
 *
 *   1. L-09 — every route that streams a user's media from Orbit's origin answers with
 *      `Cross-Origin-Resource-Policy: same-origin`, on every branch (the routes wrap their
 *      handler in `withMediaResourcePolicy`, and the helper itself is exercised here).
 *   2. L-18 — every pdfjs `getDocument` call passes `isEvalSupported: false`.
 *   3. L-17 — no server-side code formats a date for display without a `timeZone`. A Server
 *      Component formatting with the runtime's zone renders UTC on Vercel, so a 7pm Pacific
 *      meeting read as 2am the next day. Each remaining exception is listed in ALLOWLIST with
 *      the reason it is safe.
 *
 * Pure: reads source files, no database, no network. Run: npx tsx scripts/smoke-security-residuals.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { MEDIA_CORP_HEADER, MEDIA_CORP_VALUE, withMediaResourcePolicy } from "../src/lib/media-headers";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** The text between the parenthesis at `open` and its match. */
function argsAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

async function main() {
  console.log("1. media routes are same-origin only (L-09)");
  const MEDIA_ROUTES = [
    "src/app/api/avatars/[contactId]/route.ts",
    "src/app/api/capture/photos/[photoId]/route.ts",
    "src/app/api/feedback/screenshots/[shotId]/route.ts",
    "src/app/api/imports/files/[fileId]/route.ts",
  ];
  for (const route of MEDIA_ROUTES) {
    const src = read(route);
    const handlers = [...src.matchAll(/export (?:async )?function (GET|HEAD|POST|PUT|PATCH|DELETE)\b[^{]*\{([\s\S]*?)\n\}/g)];
    const wrapped =
      handlers.length > 0 && handlers.every((h) => /return withMediaResourcePolicy\(await serve\(/.test(h[2] ?? ""));
    check(`${route}: every exported handler wraps its response`, wrapped, handlers.map((h) => h[0].slice(0, 120)).join(" | "));
  }
  // Any other route that serves stored photo bytes must be added above.
  const servesStoredMedia = walk(join(ROOT, "src/app"))
    .filter((f) => f.endsWith("route.ts"))
    .map((f) => relative(ROOT, f))
    .filter((f) => /blobUrl|inlineData|profileImageUrl/.test(read(f)) && /new NextResponse\(|NextResponse\.redirect\(/.test(read(f)));
  const unlisted = servesStoredMedia.filter((f) => !MEDIA_ROUTES.includes(f));
  check("no other route serves stored media without being listed here", unlisted.length === 0, unlisted.join(", "));

  const plain = withMediaResourcePolicy(new Response("x", { headers: { "Content-Type": "image/jpeg" } }));
  check("helper: sets the header on an ordinary response", plain.headers.get(MEDIA_CORP_HEADER) === MEDIA_CORP_VALUE);
  const redirect = withMediaResourcePolicy(Response.redirect("https://example.com/a.jpg", 307));
  check(
    "helper: a redirect with immutable headers is copied, not dropped",
    redirect.status === 307 && redirect.headers.get(MEDIA_CORP_HEADER) === MEDIA_CORP_VALUE && redirect.headers.get("location") === "https://example.com/a.jpg"
  );
  check("helper: the policy is same-origin", MEDIA_CORP_VALUE === "same-origin");

  console.log("\n2. pdfjs never compiles with eval (L-18)");
  const sources = walk(join(ROOT, "src")).map((f) => relative(ROOT, f));
  let getDocumentCalls = 0;
  for (const file of sources) {
    const src = read(file);
    for (const m of src.matchAll(/\.getDocument\(/g)) {
      getDocumentCalls++;
      const args = argsAt(src, (m.index ?? 0) + ".getDocument".length);
      // Either inline, or a `params` object declared in the same file with the flag.
      const ok = /isEvalSupported:\s*false/.test(args) || (/^\s*\w+\s*$/.test(args) && new RegExp(`${args.trim()}[^=]*=\\s*\\{[^}]*isEvalSupported:\\s*false`).test(src));
      check(`${file}: getDocument passes isEvalSupported: false`, ok, args.slice(0, 120));
    }
  }
  check("found the pdfjs call sites (the scan is not vacuous)", getDocumentCalls >= 1);

  console.log("\n3. server-rendered dates carry a timeZone (L-17)");
  /**
   * Server-side date formatting that is deliberately left without the viewer's zone. Each
   * entry is `file` → a snippet of the call's own line(s) and why it is safe.
   */
  const ALLOWLIST: Array<{ file: string; snippet: string; why: string }> = [
    {
      file: "src/lib/email/schedule-presets.ts",
      snippet: "new Intl.DateTimeFormat(undefined",
      why: "runs in the browser: imported only by client components (schedule menu, compose dialog, pending sends)",
    },
    {
      file: "src/lib/demo-data/seed.ts",
      snippet: 'due.toLocaleDateString("en-US"',
      why: "demo seed text standing in for a phrase someone typed, not a rendered date",
    },
  ];
  const DATE_KEYS = /\b(weekday|month|day|hour|minute|year|dateStyle|timeStyle)\b/;
  const DATE_RECEIVER = /(?:[A-Za-z]At|[Dd]ate|[Tt]ime|new Date\([^()]*\))\)?$/;
  const offenders: string[] = [];
  let scanned = 0;
  const allowUsed = new Set<string>();
  for (const file of sources) {
    if (!/^src\/(app|components|lib)\//.test(file)) continue;
    const src = read(file);
    // Client modules format in the browser, which already has the viewer's zone.
    if (/^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(src)) continue;
    for (const m of src.matchAll(/\.toLocale(Date|Time)?String\(|Intl\.DateTimeFormat\(/g)) {
      const at = m.index ?? 0;
      const open = src.indexOf("(", at + 1);
      const args = argsAt(src, open);
      // `Intl.DateTimeFormat().resolvedOptions().timeZone` reads the zone; it formats nothing.
      if (src.startsWith(".resolvedOptions", open + args.length + 2)) continue;
      const isNumberish = m[1] === undefined && m[0].startsWith(".toLocaleString");
      if (isNumberish) {
        const receiver = src.slice(Math.max(0, at - 80), at).trimEnd();
        if (!DATE_KEYS.test(args) && !DATE_RECEIVER.test(receiver)) continue;
      }
      scanned++;
      if (/\btimeZone\b/.test(args)) continue;
      const line = src.slice(src.lastIndexOf("\n", at) + 1, src.indexOf("\n", at));
      const allowed = ALLOWLIST.find((a) => a.file === file && (line.includes(a.snippet) || src.slice(at - 120, at + 120).includes(a.snippet)));
      if (allowed) {
        allowUsed.add(`${allowed.file}:${allowed.snippet}`);
        continue;
      }
      offenders.push(`${file}:${src.slice(0, at).split("\n").length}: ${line.trim()}`);
    }
  }
  check("found server-side date formatting to check (the scan is not vacuous)", scanned >= 10, String(scanned));
  check("every server-side date format names a timeZone or is allowlisted", offenders.length === 0, offenders.join("\n       "));
  const stale = ALLOWLIST.filter((a) => !allowUsed.has(`${a.file}:${a.snippet}`));
  check("no stale allowlist entries", stale.length === 0, stale.map((a) => `${a.file}: ${a.snippet}`).join(", "));
  check(
    "the zone comes from the orbit-tz cookie via resolveTimeZone",
    /resolveTimeZone\(\(await cookies\(\)\)\.get\(TZ_COOKIE\)/.test(read("src/lib/viewer-time-zone.ts"))
  );
  check(
    "the cookie is kept current app-wide (presence heartbeat syncs it)",
    /syncTimeZoneCookie\(\)/.test(read("src/components/layout/presence-heartbeat.tsx"))
  );

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll security residual checks passed");
}

void main();
