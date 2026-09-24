/**
 * The waitlist's own domain answers the waitlist and nothing else, and stealth mode closes
 * the app domain to everyone without an account (src/lib/waitlist-host.ts).
 *
 * WHY THIS EXISTS. The allowlist is a regex inside a Next `redirects()` source, and the
 * only thing standing between a waitlist visitor and the app. A typo in it fails open —
 * `/pricing` quietly serves — or fails shut, and neither shows up in tsc or in `next dev`
 * without the host set. So the rules are replayed here through Next's OWN matchers
 * (`getPathMatch` for sources, `matchHas` for host and query conditions), in the order
 * Next applies them: redirects, then beforeFiles rewrites. Stealth is a runtime switch the
 * proxy applies, so its rules are replayed through `stealthGate` directly.
 *
 * Pure: no network, no database. Run: npx tsx scripts/smoke-waitlist-host.ts
 */
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { matchHas } from "next/dist/shared/lib/router/utils/prepare-destination";
import {
  STEALTH_HIDDEN_API,
  isWaitlistHostHeader,
  resolveStealth,
  stealthGate,
  stealthWaitlistUrl,
  waitlistHost,
  waitlistOrigin,
  waitlistRedirects,
  waitlistRewrites,
  waitlistServesPath,
  type ConfigRedirect,
  type ConfigRewrite,
} from "../src/lib/waitlist-host";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const ENV = { WAITLIST_HOST: "join.example", SITE_STEALTH: "1" };
const WAITLIST = "join.example";
const APP = "orbit.example";

type Outcome = { kind: "redirect"; to: string } | { kind: "rewrite"; to: string } | { kind: "serve"; path: string };

/** Next's order: the first matching redirect wins; otherwise the first matching rewrite. */
function route(host: string, url: string, redirects: ConfigRedirect[], rewrites: ConfigRewrite[]): Outcome {
  const parsed = new URL(url, `https://${host}`);
  const query = Object.fromEntries(parsed.searchParams);
  const req = { headers: { host } } as unknown as Parameters<typeof matchHas>[0];
  const matches = (rule: { source: string; has?: unknown[]; missing?: unknown[] }) =>
    getPathMatch(rule.source, { removeUnnamedParams: true, strict: true })(parsed.pathname) !== false &&
    matchHas(req, query, rule.has as never, rule.missing as never) !== false;
  for (const r of redirects) if (matches(r)) return { kind: "redirect", to: r.destination };
  for (const r of rewrites) if (matches(r)) return { kind: "rewrite", to: r.destination };
  return { kind: "serve", path: parsed.pathname };
}

const redirects = waitlistRedirects(ENV);
const rewrites = waitlistRewrites(ENV);
const onWaitlist = (url: string) => route(WAITLIST, url, redirects, rewrites);
const onApp = (url: string) => route(APP, url, redirects, rewrites);
const show = (o: Outcome) => JSON.stringify(o);

console.log("Config:");
check("the host is read bare", waitlistHost({ WAITLIST_HOST: " https://Join.Example/ " }) === "join.example");
check("a garbage host is ignored", waitlistHost({ WAITLIST_HOST: "not a host!" }) === null);
check("the origin defaults to https", waitlistOrigin(ENV) === "https://join.example");
check("an explicit base URL wins", waitlistOrigin({ ...ENV, WAITLIST_BASE_URL: "http://waitlist.localhost:3001/" }) === "http://waitlist.localhost:3001");
check("the host header matches with a port and www", isWaitlistHostHeader("WWW.join.example:443", ENV));
check("a lookalike host does not match", !isWaitlistHostHeader("join.example.evil.test", ENV) && !isWaitlistHostHeader("xjoin.example", ENV));
check("no host means no waitlist rules", waitlistRedirects({}).length === 0 && waitlistRewrites({}).length === 0);
check("the console's switch wins over the env", resolveStealth(false, ENV) === false && resolveStealth(true, {}) === true);
check("an untouched console defers to SITE_STEALTH", resolveStealth(null, ENV) === true && resolveStealth(null, {}) === false);

console.log("\nThe waitlist host serves the waitlist:");
check("/ is the waitlist page", show(onWaitlist("/")) === show({ kind: "rewrite", to: "/interest" }), show(onWaitlist("/")));
check("/?ref= is too", onWaitlist("/?ref=abc").kind === "rewrite");
check("/privacy is its notice", show(onWaitlist("/privacy")) === show({ kind: "rewrite", to: "/interest/privacy" }));
check("/interest folds into /", show(onWaitlist("/interest?me=x")) === show({ kind: "redirect", to: "/" }));
check("/interest/privacy folds into /privacy", show(onWaitlist("/interest/privacy")) === show({ kind: "redirect", to: "/privacy" }));
for (const icon of ["/favicon.ico", "/icon.png", "/apple-icon.png"]) {
  check(`${icon} answers with the waitlist's own icon`, show(onWaitlist(icon)) === show({ kind: "rewrite", to: "/waitlist/icon.png" }));
}
for (const path of [
  "/_next/static/chunks/app.js",
  "/api/interest-list/unsubscribe",
  "/api/interest-list/ticket-image",
  "/api/track",
  "/api/csp-report",
  "/_vercel/insights/script.js",
  "/landing/planets/saturn.png",
  "/waitlist/icon.png",
]) {
  check(`${path} is served`, onWaitlist(path).kind === "serve", show(onWaitlist(path)));
}

console.log("\n…and nothing else:");
for (const path of [
  "/pricing",
  "/sign-in",
  "/sign-up",
  "/dashboard",
  "/contacts/123",
  "/connect",
  "/contact",
  "/terms",
  "/admin",
  "/api/v1/openapi.json",
  "/api/mcp",
  "/api/health",
  "/api/interest-list/unsubscribe-all",
  "/.well-known/oauth-authorization-server",
  "/scan/token",
  "/orbit-logo.png",
  "/favicon.png",
  "/guides/linkedin/export-1.png",
  "/landing/earth.png",
  "/orbit-sw.js",
  "/privacy-policy",
  "/interesting",
]) {
  check(`${path} redirects to /`, show(onWaitlist(path)) === show({ kind: "redirect", to: "/" }), show(onWaitlist(path)));
}
check("the pure allowlist agrees with the config", ["/", "/privacy", "/api/track", "/landing/planets/earth.png"].every(waitlistServesPath) && !waitlistServesPath("/pricing") && !waitlistServesPath("/landing/earth.png"));

console.log("\nStealth on the app host:");
check("app pages are untouched by the waitlist rules", onApp("/pricing").kind === "serve" && onApp("/").kind === "serve");
const gate = (url: string, signedIn: boolean, env: Record<string, string> = ENV) => {
  const parsed = new URL(url, `https://${APP}`);
  const isApi = parsed.pathname === "/api" || parsed.pathname.startsWith("/api/");
  return JSON.stringify(stealthGate({ pathname: parsed.pathname, search: parsed.search, signedIn, isApi }, env));
};
const toWaitlist = JSON.stringify({ kind: "redirect", to: "https://join.example/" });
const pass = JSON.stringify({ kind: "pass" });
for (const path of ["/", "/pricing", "/connect", "/contact", "/privacy", "/terms", "/dashboard", "/contacts/abc", "/settings", "/onboarding", "/sign-up"]) {
  check(`signed out, ${path} goes to the waitlist`, gate(path, false) === toWaitlist, gate(path, false));
  check(`signed in, ${path} opens`, gate(path, true) === pass, gate(path, true));
}
check("a landing-page share link keeps its referrer", gate("/?ref=abc", false) === JSON.stringify({ kind: "redirect", to: "https://join.example/?ref=abc" }), gate("/?ref=abc", false));
check("sign-in stays open, steps included", ["/sign-in", "/sign-in/factor-one", "/sign-in/sso-callback"].every((p) => gate(p, false) === pass));
check("a Clerk invitation opens /sign-up", gate("/sign-up?__clerk_ticket=abc&__clerk_status=sign_up", false) === pass);
check("Clerk's own sign-up steps are left alone", gate("/sign-up/continue", false) === pass);
check("the phone scan page stays open", gate("/scan/tok123", false) === pass);
check("API routes pass, signed out or not", gate("/api/track", false) === pass && gate("/api/v1/contacts", false) === pass);
check("the API schema is hidden", gate("/api/v1/openapi.json", true) === JSON.stringify({ kind: "not-found" }));
check(
  "old /interest links move to the waitlist host",
  gate("/interest?me=abc", true) === JSON.stringify({ kind: "redirect", to: "https://join.example/?me=abc" }),
  gate("/interest?me=abc", true)
);
check(
  "old privacy links follow",
  gate("/interest/privacy", false) === JSON.stringify({ kind: "redirect", to: "https://join.example/privacy" })
);
const NO_HOST = { SITE_STEALTH: "1" };
check("with no waitlist host, the waitlist is /interest", stealthWaitlistUrl(NO_HOST) === "/interest");
check("…and signed-out pages go there", gate("/pricing", false, NO_HOST) === JSON.stringify({ kind: "redirect", to: "/interest" }));
check("…and it stays open, so there is no loop", gate("/interest", false, NO_HOST) === pass && gate("/interest/privacy", false, NO_HOST) === pass);
check("stealth hides the API schema", (STEALTH_HIDDEN_API as readonly string[]).includes("/api/v1/openapi.json"));
check("every waitlist redirect is temporary, so launch undoes it", redirects.every((r) => !r.permanent));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nThe waitlist host serves only the waitlist.");
