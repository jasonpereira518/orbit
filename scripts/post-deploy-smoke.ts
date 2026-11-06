/**
 * Post-deploy smoke: is the deployment at BASE_URL up, and does it still refuse strangers?
 *
 * Run by .github/workflows/post-deploy.yml after Vercel reports a successful production
 * deployment, and by hand against any URL:
 *
 *   BASE_URL=https://myorbitnetwork.com npx tsx scripts/post-deploy-smoke.ts
 *
 * Read-only and anonymous on purpose: it needs no secret, creates nothing, and so is safe to
 * point at production on every deploy. What it pins is the failure that a green build cannot
 * see — the app booting but the database unreachable, a page 500ing only with production
 * env, or a routing/middleware change that quietly makes a protected endpoint answer an
 * unauthenticated caller.
 *
 * Not in the smoke manifest: it talks to the real network.
 */
const BASE_URL = (process.env.BASE_URL ?? process.argv[2] ?? "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(BASE_URL)) {
  console.error("post-deploy-smoke: set BASE_URL (or pass it as the first argument), e.g. https://myorbitnetwork.com");
  process.exit(2);
}

const TIMEOUT_MS = 20_000;
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function get(path: string, init: RequestInit = {}): Promise<Response | null> {
  try {
    return await fetch(`${BASE_URL}${path}`, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
  } catch (error) {
    check(`${path} answered`, false, error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** Anything but a 2xx: a refusal, a redirect to sign-in, or a not-found all keep data in. */
const refused = (res: Response | null) => res !== null && (res.status < 200 || res.status >= 300);

async function main() {
  console.log(`post-deploy smoke against ${BASE_URL}\n`);

  console.log("health");
  const health = await get("/api/health");
  check("GET /api/health is 200", health?.status === 200, `HTTP ${health?.status}`);
  const body = health ? await health.json().catch(() => null) : null;
  check("and answers JSON", body !== null && typeof body === "object");
  check("and is not cached", (health?.headers.get("cache-control") ?? "").includes("no-store"));
  const badToken = await get("/api/health?token=not-a-real-token");
  check("a wrong health token is refused", badToken?.status === 401, `HTTP ${badToken?.status}`);

  console.log("\npublic pages render");
  for (const path of ["/", "/pricing", "/privacy", "/terms"]) {
    const res = await get(path);
    check(`GET ${path} is 200 HTML`, res?.status === 200 && (res.headers.get("content-type") ?? "").includes("text/html"), `HTTP ${res?.status}`);
  }
  const home = await get("/");
  check("security headers are set (HSTS)", Boolean(home?.headers.get("strict-transport-security")) || BASE_URL.startsWith("http://"));
  check("security headers are set (nosniff)", home?.headers.get("x-content-type-options") === "nosniff");

  console.log("\nprotected surfaces refuse an anonymous caller");
  for (const [path, init] of [
    ["/dashboard", {}],
    ["/api/v1/me", {}],
    ["/api/v1/contacts", { headers: { authorization: "Bearer orb_live_not-a-real-key" } }],
    ["/api/export", {}],
    ["/api/chat", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }],
    ["/api/admin/export", {}],
    ["/api/ops/sweep", { method: "POST" }],
    ["/api/sync/run", { method: "POST" }],
    ["/api/extension/me", {}],
    ["/api/mcp", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }],
    ["/api/calendar/not-a-real-feed-token-0000000000", {}],
  ] as Array<[string, RequestInit]>) {
    const res = await get(path, init);
    check(`${init.method ?? "GET"} ${path} is not served`, refused(res), `HTTP ${res?.status}`);
  }

  console.log("\nwebhooks refuse unsigned deliveries");
  for (const path of ["/api/webhooks/stripe", "/api/webhooks/clerk", "/api/webhooks/resend"]) {
    const res = await get(path, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    check(`POST ${path} without a signature is refused`, refused(res), `HTTP ${res?.status}`);
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\npost-deploy smoke passed");
  process.exit(failures ? 1 : 0);
}

main();
