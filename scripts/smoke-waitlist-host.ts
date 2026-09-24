/**
 * The waitlist's own domain answers the waitlist and nothing else, and stealth mode closes
 * the app domain's public face (src/lib/waitlist-host.ts).
 *
 * WHY THIS EXISTS. The allowlist is a regex inside a Next `redirects()` source, and the
 * only thing standing between a waitlist visitor and the app. A typo in it fails open —
 * `/pricing` quietly serves — or fails shut, and neither shows up in tsc or in `next dev`
 * without the host set. So the rules are replayed here through Next's OWN matchers
 * (`getPathMatch` for sources, `matchHas` for host and query conditions), in the order
 * Next applies them: redirects, then beforeFiles rewrites.
 *
 * Pure: no network, no database. Run: npx tsx scripts/smoke-waitlist-host.ts
 */
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { matchHas } from "next/dist/shared/lib/router/utils/prepare-destination";
import {
  STEALTH_CLOSED_PAGES,
  STEALTH_HIDDEN_API,
  isWaitlistHostHeader,
  stealthRedirects,
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

const redirects = [...waitlistRedirects(ENV), ...stealthRedirects(ENV)];
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
check("no stealth means no stealth rules", stealthRedirects({ WAITLIST_HOST: WAITLIST }).length === 0);

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
check("/sign-up goes to /sign-in", show(onApp("/sign-up")) === show({ kind: "redirect", to: "/sign-in" }), show(onApp("/sign-up")));
check("a Clerk invitation still opens /sign-up", onApp("/sign-up?__clerk_ticket=abc").kind === "serve");
check("Clerk's own sign-up steps are left alone", onApp("/sign-up/continue").kind === "serve");
check(
  "old /interest links move to the waitlist host",
  show(onApp("/interest?me=abc")) === show({ kind: "redirect", to: "https://join.example/" })
);
check(
  "old privacy links follow",
  show(onApp("/interest/privacy")) === show({ kind: "redirect", to: "https://join.example/privacy" })
);
check("stealth closes pricing, connect and contact", ["/pricing", "/connect", "/contact"].every((p) => (STEALTH_CLOSED_PAGES as readonly string[]).includes(p)));
check("stealth leaves the landing page open", !(STEALTH_CLOSED_PAGES as readonly string[]).includes("/"));
check("stealth hides the API schema", (STEALTH_HIDDEN_API as readonly string[]).includes("/api/v1/openapi.json"));
check("every stealth redirect is temporary, so launch undoes it", redirects.every((r) => !r.permanent));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nThe waitlist host serves only the waitlist.");
