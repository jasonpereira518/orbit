/**
 * The waitlist's own domain, and stealth mode for the app's.
 *
 * WHY A SECOND HOST. The waitlist goes out to people who must not be able to reach the app,
 * its marketing pages or its name from it. So the waitlist is served on a domain of its own
 * (`WAITLIST_HOST`) that answers ONLY the waitlist: `/` is the page, `/privacy` its notice,
 * and every other path — every page, API route and file in `public/` — redirects to `/`.
 *
 * WHY next.config RATHER THAN THE PROXY. Next runs config `redirects` before the proxy AND
 * before `public/` and `/_next/static` are served, while the proxy's matcher skips static
 * files and must be a build-time constant (it cannot name an env host). Only the config
 * layer sees every request to the waitlist host, so the allowlist lives there, built from
 * the pure functions below. The proxy's one job for this host is to skip Clerk, whose
 * handshake would otherwise redirect a visitor to the app's own Clerk domain.
 *
 * STEALTH closes the app host to everyone without an account: a signed-out visitor to any
 * page is sent to the waitlist, except `/sign-in` (existing accounts must be able to get
 * back in) and `/sign-up` carrying a Clerk invitation. Old `/interest` links move to the
 * waitlist host, and every response is `noindex`. It is a RUNTIME switch — an admin flips it
 * from the console (`site_settings`), and `SITE_STEALTH=1` is only the default for a
 * deployment nobody has toggled yet — so it lives in the proxy, never in next.config, whose
 * rules are frozen at build time. `stealthGate` below is the whole decision.
 *
 * No imports and no aliases: `next.config.ts` loads this before any alias exists, and the
 * proxy and `scripts/smoke-waitlist-host.ts` share it.
 */

type Env = Record<string, string | undefined>;

type HostMatch = { type: "host"; value: string };
type QueryMatch = { type: "query"; key: string; value?: string };

export type ConfigRedirect = {
  source: string;
  destination: string;
  permanent: boolean;
  has?: Array<HostMatch | QueryMatch>;
  missing?: Array<HostMatch | QueryMatch>;
};

export type ConfigRewrite = {
  source: string;
  destination: string;
  has?: HostMatch[];
};

/** The bare waitlist hostname, lowercased, or null when there is none. */
export function waitlistHost(env: Env = process.env): string | null {
  const raw = env.WAITLIST_HOST?.trim().toLowerCase();
  if (!raw) return null;
  // Tolerate a pasted URL or a trailing slash; keep only the hostname.
  const host = raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  return /^[a-z0-9.-]+$/.test(host) ? host : null;
}

/** Stealth's default before any admin has toggled it: the `SITE_STEALTH` env var. */
export function stealthEnvDefault(env: Env = process.env): boolean {
  return env.SITE_STEALTH === "1";
}

/**
 * Whether the site is in stealth: the admin console's switch when it has ever been set
 * (`site_settings.stealth_enabled` non-null), else the env default. Shared by the proxy's
 * reader and the server's, so the two cannot disagree about what a missing row means.
 */
export function resolveStealth(stored: boolean | null | undefined, env: Env = process.env): boolean {
  return typeof stored === "boolean" ? stored : stealthEnvDefault(env);
}

/** The waitlist's public origin: `WAITLIST_BASE_URL`, else https on the host, else null. */
export function waitlistOrigin(env: Env = process.env): string | null {
  const explicit = env.WAITLIST_BASE_URL?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const host = waitlistHost(env);
  return host ? `https://${host}` : null;
}

/** Whether a Host header (port and case ignored, `www.` allowed) is the waitlist host. */
export function isWaitlistHostHeader(hostHeader: string | null | undefined, env: Env = process.env) {
  const host = waitlistHost(env);
  if (!host || !hostHeader) return false;
  const bare = hostHeader.trim().toLowerCase().replace(/:\d+$/, "");
  return bare === host || bare === `www.${host}`;
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A `has`/`missing` host value: the host, or its `www.` form, and nothing else. */
export function hostMatchValue(host: string) {
  return `(?:www\\.)?${escapeRegex(host)}`;
}

/**
 * Paths the waitlist host serves, as regex fragments matched from the first segment.
 * Everything else redirects to `/`.
 *
 * - `privacy` (exactly): the notice, reached through the rewrite below. `/interest` and
 *   `/interest/privacy` are NOT here — they redirect to `/` and `/privacy` first.
 * - `_next/`: the page's own chunks and fonts. The server action POSTs to `/`.
 * - `api/interest-list/unsubscribe` and `/ticket-image`: the email's leave link and the
 *   share image. `api/track`: the page-view beacon. `api/csp-report`: the waitlist
 *   CSP's report target. `_vercel/`: Vercel's analytics.
 * - `landing/planets/` and `waitlist/`: the planet art and the waitlist's favicon.
 * - `favicon.ico`, `icon.png`, `apple-icon.png`: the root layout's file-based icons, which
 *   every page links. They are rewritten to the waitlist's icon below.
 * - `monitoring`: Sentry's tunnel, if one is ever configured. `__nextjs`: the dev overlay.
 *
 * Exact entries end in `$`; directory entries end in `/`. So neither `privacy-policy` nor
 * `landing/earth.png` is let through by a looser neighbour.
 */
export const WAITLIST_ALLOWED_PATHS = [
  "privacy$",
  "_next/",
  "api/interest-list/unsubscribe$",
  "api/interest-list/ticket-image$",
  "api/track$",
  "api/csp-report$",
  "_vercel/",
  "landing/planets/",
  "waitlist/",
  "favicon\\.ico$",
  "icon\\.png$",
  "apple-icon\\.png$",
  "monitoring$",
  "__nextjs",
] as const;

/**
 * The one catch-all source: any non-empty path that is not allowed above. `.+` rather
 * than `.*` so `/` itself never matches (that would loop).
 */
export function waitlistCatchAllSource() {
  return `/:path((?!${WAITLIST_ALLOWED_PATHS.join("|")}).+)`;
}

/** Whether the waitlist host would serve `pathname` rather than redirect it (for tests). */
export function waitlistServesPath(pathname: string) {
  if (pathname === "/") return true;
  const rest = pathname.replace(/^\//, "");
  return new RegExp(`^(?:${WAITLIST_ALLOWED_PATHS.join("|")})`).test(rest);
}

/** `redirects()` entries for the waitlist host. Empty when there is no host. */
export function waitlistRedirects(env: Env = process.env): ConfigRedirect[] {
  const host = waitlistHost(env);
  if (!host) return [];
  const has: HostMatch[] = [{ type: "host", value: hostMatchValue(host) }];
  return [
    // The canonical address of the page is `/`; the query (`?me=`, `?ref=`) carries over,
    // because Next passes the query through a redirect unless the destination sets one.
    { source: "/interest", destination: "/", permanent: false, has },
    { source: "/interest/privacy", destination: "/privacy", permanent: false, has },
    { source: waitlistCatchAllSource(), destination: "/", permanent: false, has },
  ];
}

/** `beforeFiles` rewrites for the waitlist host: the pages, and neutral icons. */
export function waitlistRewrites(env: Env = process.env): ConfigRewrite[] {
  const host = waitlistHost(env);
  if (!host) return [];
  const has: HostMatch[] = [{ type: "host", value: hostMatchValue(host) }];
  return [
    { source: "/", destination: "/interest", has },
    { source: "/privacy", destination: "/interest/privacy", has },
    // The root layout's file-based icons are the product's logo. On this host the same
    // URLs answer with the waitlist's planet instead, so the links in the HTML stay put.
    { source: "/favicon.ico", destination: "/waitlist/icon.png", has },
    { source: "/icon.png", destination: "/waitlist/icon.png", has },
    { source: "/apple-icon.png", destination: "/waitlist/icon.png", has },
  ];
}

/**
 * Local-only preview of the waitlist: `/waitlist` and `/waitlist/privacy` on localhost render
 * the pages the waitlist host serves at `/` and `/privacy`, since `*.localhost` host routing
 * is awkward and the real rewrites match on the Host header. Never emitted outside `next dev`,
 * so production and preview builds keep 404ing on `/waitlist` (`public/waitlist/` only holds
 * the icon).
 */
export function localWaitlistRewrites(env: Env = process.env): ConfigRewrite[] {
  if (env.NODE_ENV !== "development") return [];
  return [
    { source: "/waitlist", destination: "/interest" },
    { source: "/waitlist/privacy", destination: "/interest/privacy" },
  ];
}

/**
 * Where stealth sends someone without an account: the waitlist host's `/` when there is
 * one, else `/interest` on the app host itself (which stealth then leaves open).
 */
export function stealthWaitlistUrl(env: Env = process.env): string {
  const origin = waitlistOrigin(env);
  return origin ? `${origin}/` : "/interest";
}

/** API paths that answer 404 in stealth mode. */
export const STEALTH_HIDDEN_API = ["/api/v1/openapi.json"] as const;

/**
 * Page paths a signed-out visitor may still open in stealth, as prefixes (`/sign-in` covers
 * Clerk's own `/sign-in/factor-one`, `/sign-in/sso-callback`, …).
 *
 * - `/sign-in`: people who already have an account need a way back in.
 * - `/sign-up/` sub-paths: Clerk's later sign-up steps. A bare `/sign-up` is handled on its
 *   own below — it opens only with an invitation ticket. Without one, no step after it can
 *   start either: the sub-paths bounce back to `/sign-up`, which bounces to the waitlist.
 * - `/scan/`: the phone half of note scanning, authenticated by a token in the path and
 *   opened by an existing user's own phone.
 * - `/.well-known/` and `/__clerk/`: machine endpoints (OAuth discovery, Clerk's proxy).
 */
export const STEALTH_OPEN_PREFIXES = [
  "/sign-in",
  "/sign-up/",
  "/scan/",
  "/.well-known/",
  "/__clerk/",
] as const;

/** The query key a Clerk invitation link lands on `/sign-up` with. */
export const CLERK_TICKET_PARAM = "__clerk_ticket";

export type StealthGate =
  | { kind: "pass" }
  | { kind: "not-found" }
  | { kind: "redirect"; to: string };

/**
 * Stealth's decision for one request to the APP host. Call it only while stealth is on.
 *
 * Signed in is the whole test for "has an account": the proxy cannot see more than the
 * session, and an account that was created behind stealth's back (a Google sign-in on
 * `/sign-in` makes one) is caught one layer down, by `src/lib/site-access.ts`.
 *
 * API routes always pass — they carry their own authentication and answer JSON, and a
 * redirect would hand an API client the waitlist's HTML as a 200.
 */
export function stealthGate(
  input: { pathname: string; search: string; signedIn: boolean; isApi: boolean },
  env: Env = process.env
): StealthGate {
  const { pathname, search, signedIn, isApi } = input;

  if ((STEALTH_HIDDEN_API as readonly string[]).includes(pathname)) return { kind: "not-found" };

  // Old waitlist links, for everyone: the waitlist has moved to its own host. Tickets and
  // share links (`?me=`, `?ref=`) ride along. With no waitlist host, `/interest` IS the
  // waitlist, so it stays open.
  const origin = waitlistOrigin(env);
  if (pathname === "/interest" || pathname === "/interest/privacy") {
    if (!origin) return { kind: "pass" };
    return { kind: "redirect", to: `${origin}${pathname === "/interest" ? "/" : "/privacy"}${search}` };
  }

  if (isApi || signedIn) return { kind: "pass" };
  if (STEALTH_OPEN_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return { kind: "pass" };
  if (pathname === "/sign-up" && new URLSearchParams(search).has(CLERK_TICKET_PARAM)) {
    return { kind: "pass" };
  }

  // Everything else — the landing page, marketing, legal, the app itself, a bare /sign-up.
  // The landing page's query rides along so a share link (`/?ref=`) keeps its referrer.
  const to = stealthWaitlistUrl(env);
  return { kind: "redirect", to: pathname === "/" && origin ? `${to}${search}` : to };
}

export const STEALTH_ROBOTS = "noindex, nofollow";
