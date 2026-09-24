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
 * STEALTH (`SITE_STEALTH=1`) closes the app host's public face: the marketing pages need a
 * session, `/sign-up` sends people to `/sign-in` unless they carry a Clerk invitation, old
 * `/interest` links move to the waitlist host, and every response is `noindex`.
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

export function isStealth(env: Env = process.env): boolean {
  return env.SITE_STEALTH === "1";
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
 * `redirects()` entries for the APP host in stealth mode. The session-dependent rules (the
 * marketing pages, `/`) live in the proxy, which can read the session; these need none.
 */
export function stealthRedirects(env: Env = process.env): ConfigRedirect[] {
  if (!isStealth(env)) return [];
  const host = waitlistHost(env);
  const missing: HostMatch[] = host ? [{ type: "host", value: hostMatchValue(host) }] : [];
  const out: ConfigRedirect[] = [
    // Sign-up is closed. A Clerk invitation lands on `/sign-up?__clerk_ticket=…`, so that
    // one still opens; Clerk's own later steps (`/sign-up/continue`, …) are sub-paths and
    // are left alone — without a ticket, a Restricted Clerk instance never starts one.
    {
      source: "/sign-up",
      destination: "/sign-in",
      permanent: false,
      missing: [...missing, { type: "query", key: "__clerk_ticket" }],
    },
  ];
  const origin = waitlistOrigin(env);
  if (origin) {
    // Tickets and share links from before the move still resolve: `?me=` / `?ref=` ride
    // along to the waitlist host's `/`.
    out.push(
      { source: "/interest", destination: `${origin}/`, permanent: false, missing },
      { source: "/interest/privacy", destination: `${origin}/privacy`, permanent: false, missing }
    );
  }
  return out;
}

/** Pages that are public on the app host normally and need a session in stealth mode. */
export const STEALTH_CLOSED_PAGES = ["/", "/pricing", "/connect", "/contact"] as const;

/** API paths that answer 404 in stealth mode. */
export const STEALTH_HIDDEN_API = ["/api/v1/openapi.json"] as const;

export const STEALTH_ROBOTS = "noindex, nofollow";
