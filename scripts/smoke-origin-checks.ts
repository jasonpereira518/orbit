/**
 * Every mutating route handler refuses a cross-site browser request, or says why it may not
 * (audit L-01, FIX_PLAN 3.3).
 *
 *  1. Parser check: each POST / PUT / PATCH / DELETE handler under `src/app/api` either calls
 *     `sameOriginGuard(` / `assertSameOrigin(` in its own body, or its route is on
 *     `CROSS_ORIGIN_ALLOWED` below with the reason it carries its own credential. A new
 *     cookie-authenticated handler that forgets the guard fails here, and so does a stale
 *     allowlist entry or an allowlisted route that starts reading the session cookie.
 *  2. Unit checks of the helper itself: same host, forwarded host, another site, `null`,
 *     no Origin, `Sec-Fetch-Site`, and the JSON `Content-Type` rule.
 *
 * Pure: reads source files, builds `Request`s. Run: npx tsx scripts/smoke-origin-checks.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { assertSameOrigin, sameOriginGuard, sameOriginRefusal } from "../src/lib/api/same-origin";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  }
}

/**
 * Mutating routes that are exempt from the same-origin guard, by route directory under
 * `src/app/api` (a trailing `/` covers everything below it). Each one authenticates with
 * something a cross-site page cannot attach — or is meant to be called cross-origin — so
 * the browser's cookie is not what lets the request through.
 */
const CROSS_ORIGIN_ALLOWED: Record<string, string> = {
  // The Chrome extension: calls from a chrome-extension:// origin with a Clerk session token in
  // `Authorization: Bearer` (extension/src/lib/api.ts), through `extensionRoute`.
  "extension/": "browser extension, bearer session token, own envelope",
  // The public API and MCP: bearer API keys / OAuth access tokens, never cookies. No CORS.
  "v1/": "public API, bearer API key",
  "mcp": "MCP, bearer API key or OAuth token",
  "mcp/[token]": "MCP URL key (the key is in the path)",
  // Signed webhooks from third parties' servers.
  "webhooks/stripe": "Stripe signature",
  "webhooks/clerk": "Clerk (svix) signature",
  "webhooks/resend": "Resend (svix) signature, inbound mail and delivery events",
  // One-click unsubscribe (RFC 8058): the mail provider POSTs cross-origin; the token in the URL is the credential.
  "credits/email/unsubscribe": "one-click unsubscribe, URL token",
  "interest-list/unsubscribe": "one-click unsubscribe, URL token",
  "radar/digest/unsubscribe": "one-click unsubscribe, URL token",
  // Browsers' own CSP violation reports: sent without credentials, from any page.
  "csp-report": "browser CSP reports, no credentials",
  // The phone scan handoff: the short-lived token in the path is the credential.
  "scan/[token]/pages": "scan handoff token",
  "scan/[token]/finish": "scan handoff token",
  // Cron and internal fan-out: `isInternalRequest` (Bearer CRON_SECRET), never a cookie.
  "avatars/encode": "internal secret",
  "capture/jobs/[id]/run": "internal secret",
  "cloud-notes/run": "cron secret",
  "connectors/outbox/drain": "cron secret",
  "credits/notices": "cron secret",
  "email/drain": "cron secret",
  "embeddings/backfill": "internal secret",
  "imports/[id]/continue": "internal secret",
  "jobs/feed/sweep": "cron secret",
  "linkedin/timeline-events/backfill": "internal secret",
  "ops/speech-usage": "cron secret",
  "ops/sweep": "cron secret",
  "radar/digest": "cron secret",
  "radar/feeds/sweep": "cron secret",
  "radar/run": "cron secret",
  "relationships/run": "cron secret",
  "sync/run": "cron secret",
  "webhooks/outbound/drain": "cron secret",
  "work-history/research": "internal secret",
  "work-history/sweep": "cron secret",
};

/** Session-cookie authentication. An allowlisted route must not use any of these. */
const COOKIE_AUTH =
  /\b(requireUserId|requireUserForSurface|requireUserForReleasedSurface|requireMeetingsUser|requireAuthenticatedUser|requireRecruitersUser|requireOutreachUser|requireAdmin\w*|currentUser)\s*\(|\bauth\(\)/;
const GUARD = /\b(sameOriginGuard|assertSameOrigin)\s*\(/;
const METHOD = /export\s+(?:async\s+function\s+|const\s+)(POST|PUT|PATCH|DELETE)\b/g;

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...routeFiles(path));
    else if (name === "route.ts") out.push(path);
  }
  return out;
}

/** The handler's own text: from its `export` to the next top-level `export` (or the file's end). */
function handlerText(source: string, start: number): string {
  const next = source.slice(start + 1).search(/\nexport\s/);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

/** Comments out, so a guard named in prose does not count. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function allowance(route: string): string | null {
  if (CROSS_ORIGIN_ALLOWED[route]) return route;
  const prefix = Object.keys(CROSS_ORIGIN_ALLOWED).find((k) => k.endsWith("/") && route.startsWith(k));
  return prefix ?? null;
}

function parserCheck() {
  console.log("Every mutating handler is guarded or allowlisted");
  const root = "src/app/api";
  const used = new Set<string>();
  const unguarded: string[] = [];
  let guarded = 0;
  for (const file of routeFiles(root).sort()) {
    const route = relative(root, file).replace(/\/route\.ts$/, "");
    const source = readFileSync(file, "utf8");
    const body = code(source);
    for (const m of body.matchAll(METHOD)) {
      const text = handlerText(body, m.index!);
      if (GUARD.test(text)) {
        guarded++;
        continue;
      }
      const allowed = allowance(route);
      if (allowed) {
        used.add(allowed);
        continue;
      }
      unguarded.push(`${m[1]} /api/${route}${COOKIE_AUTH.test(body) ? " (cookie-authenticated)" : ""}`);
    }
    const allowed = allowance(route);
    if (allowed && COOKIE_AUTH.test(body) && !GUARD.test(body)) {
      unguarded.push(`/api/${route} is allowlisted ("${CROSS_ORIGIN_ALLOWED[allowed]}") but reads the session cookie`);
    }
  }
  check(`${guarded} handlers call the guard`, guarded >= 12, guarded);
  check("no mutating handler is unguarded and unlisted", unguarded.length === 0, unguarded.join("\n       "));
  const stale = Object.keys(CROSS_ORIGIN_ALLOWED).filter((k) => !used.has(k));
  check("every allowlist entry still names a mutating route", stale.length === 0, stale);

  // The handlers the audit named, by name, so a refactor that moves the guard is still caught.
  for (const route of [
    "chat",
    "capture/jobs",
    "capture/meetings/[id]/chunks",
    "capture/meetings/[id]/segments",
    "capture/meetings/[id]/stream-token",
    "speech/token",
    "speech/usage",
    "knowledge/refresh",
    "research",
    "contacts/avatar-backfill",
    "email/attachments/upload",
    "plan-upgrades/claim",
    "presence",
    "track",
  ]) {
    const source = code(readFileSync(join(root, route, "route.ts"), "utf8"));
    check(`/api/${route} calls the guard`, GUARD.test(source));
  }
  // JSON readers declare it, so a text/plain or form body is refused before it is parsed.
  for (const route of ["chat", "knowledge/refresh", "research", "speech/usage", "capture/meetings/[id]/segments", "contacts/avatar-backfill", "email/attachments/upload"]) {
    const source = code(readFileSync(join(root, route, "route.ts"), "utf8"));
    check(`/api/${route} requires a JSON body`, /sameOriginGuard\(request, \{[^}]*json: true/.test(source));
  }
}

function req(headers: Record<string, string>, url = "https://orbit.example/api/chat") {
  return new Request(url, { method: "POST", headers });
}

function helperChecks() {
  console.log("\nThe helper");
  const host = { host: "orbit.example" };
  check("same host → allowed", sameOriginRefusal(req({ ...host, origin: "https://orbit.example" })) === null);
  check("forwarded host (behind Vercel's proxy) → allowed",
    sameOriginRefusal(req({ host: "internal:3000", "x-forwarded-host": "app.orbit.example", origin: "https://app.orbit.example" }, "http://internal:3000/api/chat")) === null);
  check("host names compare case-insensitively", sameOriginRefusal(req({ ...host, origin: "https://ORBIT.example" })) === null);
  check("another site → 403", sameOriginRefusal(req({ ...host, origin: "https://evil.example" }))?.status === 403);
  check("a look-alike suffix → 403", sameOriginRefusal(req({ ...host, origin: "https://orbit.example.evil.example" }))?.status === 403);
  check("same host, another port → 403", sameOriginRefusal(req({ ...host, origin: "https://orbit.example:8443" }))?.status === 403);
  check("Origin: null (sandboxed frame, privacy redirect) → 403", sameOriginRefusal(req({ ...host, origin: "null" }))?.status === 403);
  check("a chrome-extension origin → 403 (the extension has its own routes)",
    sameOriginRefusal(req({ ...host, origin: "chrome-extension://abcdefghijklmnop" }))?.status === 403);
  check("no Origin (a same-origin navigation, a server client) → allowed", sameOriginRefusal(req(host)) === null);
  check("no Origin but Sec-Fetch-Site: same-origin → allowed", sameOriginRefusal(req({ ...host, "sec-fetch-site": "same-origin" })) === null);
  check("no Origin but Sec-Fetch-Site: cross-site → 403", sameOriginRefusal(req({ ...host, "sec-fetch-site": "cross-site" }))?.status === 403);
  check("the route's own wording is kept", sameOriginRefusal(req({ ...host, origin: "https://evil.example" }), { message: "Cross-origin upload refused" })?.message === "Cross-origin upload refused");

  console.log("\nThe JSON Content-Type rule");
  const same = { ...host, origin: "https://orbit.example" };
  check("application/json → allowed", sameOriginRefusal(req({ ...same, "content-type": "application/json" }), { json: true }) === null);
  check("application/json; charset=utf-8 → allowed", sameOriginRefusal(req({ ...same, "content-type": "application/json; charset=utf-8" }), { json: true }) === null);
  check("a +json type → allowed", sameOriginRefusal(req({ ...same, "content-type": "application/vnd.api+json" }), { json: true }) === null);
  check("no Content-Type (no body) → allowed", sameOriginRefusal(req(same), { json: true }) === null);
  check("text/plain → 415", sameOriginRefusal(req({ ...same, "content-type": "text/plain;charset=UTF-8" }), { json: true })?.status === 415);
  check("a form post → 415", sameOriginRefusal(req({ ...same, "content-type": "application/x-www-form-urlencoded" }), { json: true })?.status === 415);
  check("multipart → 415", sameOriginRefusal(req({ ...same, "content-type": "multipart/form-data; boundary=x" }), { json: true })?.status === 415);
  check("application/jsonp is not JSON → 415", sameOriginRefusal(req({ ...same, "content-type": "application/jsonp" }), { json: true })?.status === 415);
  check("without `json`, any type is fine", sameOriginRefusal(req({ ...same, "content-type": "multipart/form-data; boundary=x" })) === null);

  console.log("\nThe two call shapes");
  let threw: unknown = null;
  try {
    assertSameOrigin(req({ ...host, origin: "https://evil.example" }));
  } catch (err) {
    threw = err;
  }
  check("assertSameOrigin throws a RequestRefusedError", (threw as Error | null)?.name === "RequestRefusedError" && (threw as { status?: number }).status === 403);
  const res = sameOriginGuard(req({ ...host, origin: "https://evil.example" }));
  check("sameOriginGuard returns the 403 response", res?.status === 403);
  check("…and null when allowed", sameOriginGuard(req({ ...host, origin: "https://orbit.example" })) === null);
}

async function main() {
  parserCheck();
  helperChecks();
  const res = sameOriginGuard(req({ host: "orbit.example", origin: "https://evil.example" }));
  const body = (await res?.json()) as { error?: string } | undefined;
  check("the refusal body is { error }, like every other route refusal", body?.error === "Cross-origin request refused", body);
  if (failures) {
    console.error(`\n${failures} origin check(s) failed`);
    process.exit(1);
  }
  console.log("\nsmoke-origin-checks: all checks passed");
}

void main();
