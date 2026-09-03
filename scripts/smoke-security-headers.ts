/**
 * Pins the security headers Orbit sends (`src/lib/security-headers.ts`).
 *
 * Orbit renders user-supplied contact notes and markdown from a model, embeds Clerk, and
 * redirects to Stripe — and sent no security headers at all. The CSP starts REPORT-ONLY,
 * because a wrong origin in an enforced policy silently breaks sign-in or checkout; it is
 * flipped to enforce with `CSP_ENFORCE=1` once `/api/csp-report` has stayed quiet.
 *
 * Pure: no network, no database. Run: npx tsx scripts/smoke-security-headers.ts
 */
import { buildSecurityHeaders, clerkFrontendApiHost } from "../src/lib/security-headers";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const header = (headers: Array<{ key: string; value: string }>, key: string) =>
  headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value ?? null;

function main() {
  console.log("Clerk frontend API host...");
  // A publishable key is `pk_<env>_` + base64("<frontend-api-host>$").
  const pk = "pk_live_" + Buffer.from("clerk.orbit.jasonpereira.live$").toString("base64");
  check("derived from a live publishable key", clerkFrontendApiHost(pk) === "clerk.orbit.jasonpereira.live");
  check("a test key resolves its accounts.dev host",
    clerkFrontendApiHost("pk_test_" + Buffer.from("amazing-fox-12.clerk.accounts.dev$").toString("base64")) === "amazing-fox-12.clerk.accounts.dev");
  check("garbage yields null", clerkFrontendApiHost("nope") === null && clerkFrontendApiHost(undefined) === null);

  console.log("\nProduction, report-only (the default)...");
  const prod = buildSecurityHeaders({ dev: false, enforce: false, clerkPublishableKey: pk });
  check("HSTS with a long max-age and subdomains", /max-age=\d{8,}; includeSubDomains/.test(header(prod, "Strict-Transport-Security") ?? ""));
  check("nosniff", header(prod, "X-Content-Type-Options") === "nosniff");
  check("Referrer-Policy strict-origin-when-cross-origin", header(prod, "Referrer-Policy") === "strict-origin-when-cross-origin");
  check("X-Frame-Options DENY", header(prod, "X-Frame-Options") === "DENY");
  check("Permissions-Policy allows camera/mic to self only", /camera=\(self\)/.test(header(prod, "Permissions-Policy") ?? "") && /geolocation=\(\)/.test(header(prod, "Permissions-Policy") ?? ""));
  const csp = header(prod, "Content-Security-Policy-Report-Only");
  check("CSP is report-only by default", Boolean(csp) && header(prod, "Content-Security-Policy") === null);
  check("script-src allows self, inline, Clerk and Turnstile",
    /script-src[^;]*'self'/.test(csp ?? "") && /script-src[^;]*'unsafe-inline'/.test(csp ?? "") && /script-src[^;]*https:\/\/clerk\.orbit\.jasonpereira\.live/.test(csp ?? "") && /script-src[^;]*challenges\.cloudflare\.com/.test(csp ?? ""), csp ?? "");
  check("script-src does not allow eval in production", !/script-src[^;]*unsafe-eval/.test(csp ?? ""));
  check("connect-src allows Clerk, Sentry ingest and Vercel Analytics",
    /connect-src[^;]*clerk\.orbit\.jasonpereira\.live/.test(csp ?? "") && /connect-src[^;]*\*\.ingest\.(us\.)?sentry\.io/.test(csp ?? "") && /connect-src[^;]*va\.vercel-scripts\.com/.test(csp ?? ""), csp ?? "");
  check("img-src allows https, data and blob (avatars come from anywhere)", /img-src[^;]*https:/.test(csp ?? "") && /img-src[^;]*data:/.test(csp ?? "") && /img-src[^;]*blob:/.test(csp ?? ""));
  check("frame-ancestors none, object-src none, base-uri self", /frame-ancestors 'none'/.test(csp ?? "") && /object-src 'none'/.test(csp ?? "") && /base-uri 'self'/.test(csp ?? ""));
  check("reports go to /api/csp-report", /report-uri \/api\/csp-report/.test(csp ?? ""));
  check("frame-src allows Clerk and Turnstile", /frame-src[^;]*clerk\.orbit\.jasonpereira\.live/.test(csp ?? "") && /frame-src[^;]*challenges\.cloudflare\.com/.test(csp ?? ""));

  console.log("\nEnforced...");
  const enforced = buildSecurityHeaders({ dev: false, enforce: true, clerkPublishableKey: pk });
  check("CSP_ENFORCE moves the policy to the enforcing header", Boolean(header(enforced, "Content-Security-Policy")) && header(enforced, "Content-Security-Policy-Report-Only") === null);

  console.log("\nDevelopment...");
  const dev = buildSecurityHeaders({ dev: true, enforce: false, clerkPublishableKey: undefined });
  const devCsp = header(dev, "Content-Security-Policy-Report-Only") ?? "";
  check("dev allows eval (React refresh) and the Vercel dev scripts", /unsafe-eval/.test(devCsp) && /va\.vercel-scripts\.com/.test(devCsp));
  check("dev without Clerk keys still produces a valid policy", devCsp.length > 0 && !/undefined/.test(devCsp));
  check("no HSTS in development", header(dev, "Strict-Transport-Security") === null);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll security-header checks passed.");
}

main();
