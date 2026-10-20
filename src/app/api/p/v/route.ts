import { NextResponse } from "next/server";
import { auth, verifyToken } from "@clerk/nextjs/server";
import { isDemoMode } from "@/lib/auth";
import { isInternalUser } from "@/lib/analytics-internal";
import { reportError } from "@/lib/report-error";
import { clerkJwtKey } from "@/lib/clerk-jwt-key";
import { attributionFromUrl } from "@/lib/attribution-parse";
import { isBotUserAgent } from "@/lib/analytics-bots";
import { isTrackedPath, normalizeRoute } from "@/lib/analytics-routes";
import { isWaitlistHostHeader } from "@/lib/waitlist-host";
import { bareHost, isOwnOrRoundTrip } from "@/lib/round-trip-hosts";
import { linkSignupSession } from "@/lib/signup-session";
import {
  analyticsEnabled,
  deviceFromUserAgent,
  hashVisitor,
} from "@/lib/analytics-visitor";
import { recordDwell, recordLoad, recordPageView } from "@/lib/page-views";
import { sameOriginGuard } from "@/lib/api/same-origin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * THE PATH IS DELIBERATELY NEUTRAL. This was `/api/track`, which EasyPrivacy-style ad-blocker
 * lists match by pattern, silently removing whole visits with no counter (audit D5). It lives
 * at `/api/p/v` now; `/api/track` re-exports this handler for one release so a cached client
 * keeps reporting. Do not rename it back to anything that says "track", "analytics" or "beacon".
 *
 * Traffic ingest. The client beacon in `src/components/analytics/pageview-beacon.tsx`
 * POSTs one of these per page view, a `load` once its content is on screen, then a `dwell`
 * for it on the way out.
 *
 * ONE VERB, TWO KINDS, and not because that is prettier. The exit message has to survive
 * the page being torn down, which means `navigator.sendBeacon` — the only transport the
 * browser guarantees to flush during unload. `sendBeacon` can issue nothing but POST, so a
 * PATCH route would compile, look correct, and never once fire in production.
 *
 * NODEJS RUNTIME, NOT MIDDLEWARE. `src/proxy.ts` sees every request and would be the
 * obvious place to count them — but it runs on the edge, where `@/db` cannot be imported
 * at all (PGlite reaches for `node:fs`). It would also be *worse* data: middleware counts
 * prefetches, RSC payload fetches and every crawler, none of which is a person looking at
 * a page. A beacon that only fires from rendered JavaScript is both possible and more
 * honest.
 *
 * ALWAYS 204, like `/api/presence`. Analytics is the product's least important write; a
 * visitor must never see a consequence of it failing, and the client does not retry.
 *
 * The route is in `PUBLIC_ROUTES` because anonymous marketing traffic is most of the
 * point. `auth()` still resolves a signed-in user when there is one, which is what makes
 * the signed-in/anonymous split on the admin page possible.
 */

const OK = () => new NextResponse(null, { status: 204 });

/**
 * Per-instance abuse guard, keyed on the client IP — not the visitor hash, which folds in
 * the User-Agent and so reset for anyone who changed it — and checked before any branch, so
 * the dwell and load updates are metered too. The address is held in this Map only.
 *
 * Deliberately in memory rather than `rate_limit_buckets`: that limiter costs a Postgres
 * upsert per check, which would double the write volume of the entire pipeline to police
 * it. Fluid Compute reuses instances, so a Map is good enough for the only threat that
 * matters here — someone curling the endpoint in a loop to poison the numbers.
 */
const RATE_WINDOW_MS = 60_000;
/** Per IP, and a page sends up to three beacons (view, load, dwell): room for a campus NAT. */
const RATE_MAX = 240;
const recentByVisitor = new Map<string, number[]>();

function overRateLimit(key: string, now: number) {
  const recent = (recentByVisitor.get(key) ?? []).filter(
    (at) => now - at < RATE_WINDOW_MS
  );
  if (recent.length >= RATE_MAX) {
    recentByVisitor.set(key, recent);
    return true;
  }
  recent.push(now);
  recentByVisitor.set(key, recent);

  // Same bound as the interest-list guard: without this the map grows for the lifetime
  // of the instance.
  if (recentByVisitor.size > 1000) {
    for (const [k, times] of recentByVisitor) {
      if (times.every((at) => now - at >= RATE_WINDOW_MS)) recentByVisitor.delete(k);
    }
  }
  return false;
}

/**
 * `x-real-ip` first: on Vercel it is the connecting client, set by the platform and not
 * forwardable. The first `x-forwarded-for` hop is only trustworthy because Vercel overwrites
 * that header too, so it is the fallback rather than the source — behind any other proxy a
 * client could write it, and with it choose its own visitor hash.
 */
function clientIp(headers: Headers): string {
  return (
    headers.get("x-real-ip")?.trim() ||
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/**
 * Whether this deployment's views belong in the table at all.
 *
 * PREVIEWS NEVER RECORD. A preview that shares production's database (the guard in
 * `env.ts` is unarmed without PRODUCTION_DB_HOST) would otherwise write reviewers' clicks
 * into the real numbers. `next dev` records only into local PGlite: with `.env.local`
 * pointing DATABASE_URL at Neon, a developer's StrictMode double-mounts landed there too.
 * Anything else — production, `next start`, the smoke suite — records as before.
 */
function recordsHere(env = process.env): boolean {
  if (env.VERCEL_ENV && env.VERCEL_ENV !== "production") return false;
  if (env.NODE_ENV === "development" && env.DATABASE_URL?.trim()) return false;
  return true;
}

// The round-trip host filter (`isOwnOrRoundTrip`) is shared with the proxy's first-touch
// capture: see `@/lib/round-trip-hosts`.

/**
 * The account behind an EXPIRED session token.
 *
 * The marketing pages mount no ClerkProvider (see `landing-auth-controls.tsx`), so nothing
 * refreshes Clerk's ~60-second `__session` JWT there, and `auth()` treats the stale token as
 * signed out. Every signed-in customer who wandered back to `/` or `/pricing` a minute after
 * leaving the app was counted as an anonymous prospect — which also put them in the funnel's
 * visitor stage.
 *
 * The signature is still verified; only the expiry is relaxed, by up to a week. This is
 * attribution on an analytics row and grants nothing, and a forged cookie fails the
 * signature check exactly as it would anywhere else.
 */
const STALE_SESSION_GRACE_MS = 7 * 86_400_000;

async function userFromStaleSession(request: Request): Promise<string | null> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) return null;
  const cookie = request.headers.get("cookie") ?? "";
  const token = /(?:^|;\s*)__session=([^;]+)/.exec(cookie)?.[1];
  if (!token) return null;
  try {
    const jwtKey = clerkJwtKey();
    const claims = await verifyToken(decodeURIComponent(token), {
      secretKey,
      ...(jwtKey ? { jwtKey } : {}),
      clockSkewInMs: STALE_SESSION_GRACE_MS,
    });
    return typeof claims.sub === "string" ? claims.sub : null;
  } catch {
    return null;
  }
}

/** Vercel sets these on every request in production. All three are null locally. */
function geoFrom(headers: Headers) {
  const decode = (value: string | null) => {
    if (!value) return null;
    try {
      return decodeURIComponent(value).slice(0, 128) || null;
    } catch {
      return value.slice(0, 128) || null;
    }
  };
  return {
    country: decode(headers.get("x-vercel-ip-country")),
    region: decode(headers.get("x-vercel-ip-country-region")),
    city: decode(headers.get("x-vercel-ip-city")),
  };
}

const isUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export async function POST(request: Request) {
  if (!analyticsEnabled() || !recordsHere()) return OK();
  // Reads the session cookie to attribute the view, so a cross-site post is dropped (L-01).
  // Always 204, as before: the beacon cannot read a response.
  if (sameOriginGuard(request, { json: true })) return OK();
  if (overRateLimit(clientIp(request.headers), Date.now())) return OK();

  try {
    const body = (await request.json().catch(() => null)) as {
      kind?: unknown;
      id?: unknown;
      sessionId?: unknown;
      path?: unknown;
      url?: unknown;
      referrer?: unknown;
      dwellMs?: unknown;
      loadMs?: unknown;
      navType?: unknown;
      internal?: unknown;
      automated?: unknown;
    } | null;

    if (!body || !isUuid(body.id)) return OK();

    // Time-on-page, sent by `sendBeacon` as the page goes away.
    if (body.kind === "dwell") {
      if (typeof body.dwellMs === "number") await recordDwell(body.id, body.dwellMs);
      return OK();
    }

    // Time until the page's content was on screen, sent once the skeletons are gone.
    if (body.kind === "load") {
      if (
        typeof body.loadMs === "number" &&
        (body.navType === "hard" || body.navType === "soft")
      ) {
        await recordLoad(body.id, body.loadMs, body.navType);
      }
      return OK();
    }

    if (!isUuid(body.sessionId)) return OK();
    if (typeof body.path !== "string" || !isTrackedPath(body.path)) return OK();

    const headers = request.headers;
    const userAgent = headers.get("user-agent") ?? "";
    const visitorHash = hashVisitor(clientIp(headers), userAgent);

    // The client sends its full URL so the UTMs can be read here rather than trusted from
    // it. `attributionFromUrl` is the same parser the signup attribution cookie uses, so a
    // campaign is spelled identically in both places.
    const url = typeof body.url === "string" ? body.url : "";
    const referrer = typeof body.referrer === "string" ? body.referrer : null;
    const attribution = attributionFromUrl(url, referrer);
    const geo = geoFrom(headers);

    // `referrerHost` parses a host and nothing more — it does NOT drop same-origin (the
    // middleware does that for itself, separately). Without this, every full-page load
    // from one Orbit page to another records Orbit as its own top referrer.
    const ownHost = bareHost(headers.get("x-forwarded-host") ?? headers.get("host"));
    const externalReferrer =
      attribution.referrer && !isOwnOrRoundTrip(attribution.referrer, ownHost)
        ? attribution.referrer
        : null;

    // Demo mode has no Clerk, so `auth()` yields nothing and every local page view would
    // record as anonymous — which makes the per-account breakdown impossible to see while
    // developing it. `requireUserId()` is the wrong tool: it throws when signed out and
    // bootstraps a user row on the way, and a fire-and-forget beacon must do neither.
    let userId: string | null = isDemoMode() ? "demo-user" : null;
    if (!userId) {
      try {
        userId = (await auth()).userId ?? null;
      } catch {
        // Signed out, or Clerk unconfigured. Both are ordinary here.
      }
    }
    if (!userId) userId = await userFromStaleSession(request);

    const route = routeFor(body.path, headers.get("host"));
    const isBot = isBotUserAgent(userAgent) || body.automated === true;
    await recordPageView({
      id: body.id,
      visitorHash,
      sessionId: body.sessionId,
      userId,
      route,
      referrerHost: externalReferrer,
      utmSource: attribution.utmSource,
      utmMedium: attribution.utmMedium,
      utmCampaign: attribution.utmCampaign,
      country: geo.country,
      region: geo.region,
      city: geo.city,
      device: deviceFromUserAgent(userAgent),
      // `navigator.webdriver` is true under Playwright, Puppeteer and Selenium even when they
      // spoof a real user agent. A client could lie about it, but only in the direction of
      // being filtered out.
      isBot,
      isInternal: body.internal === true || isInternalUser(userId),
    });

    // The first signed-in view of a new account closes the session -> account link and emits
    // `first_app_load`. Its own failure must not cost the view above, which has landed.
    if (userId && !isBot) {
      await linkSignupSession({ userId, sessionId: body.sessionId, route }).catch((err) =>
        reportError(err, { where: "api.track.signup_session", level: "warning" })
      );
    }
  } catch (err) {
    // Still a 204: none of this is the visitor's problem. But it IS the operator's — a
    // missing column after a bad migration used to look like a quiet week on the admin page,
    // with nothing anywhere saying otherwise. A warning is throttled to one a minute.
    reportError(err, { where: "api.track", level: "warning" });
  }

  return OK();
}

/**
 * On the waitlist's own domain the page lives at `/` and its notice at `/privacy` — the
 * app's landing and policy paths. Recorded under the waitlist's app-side routes instead,
 * so its traffic is never counted as the landing page's.
 */
function routeFor(path: string, host: string | null): string {
  if (!isWaitlistHostHeader(host)) return normalizeRoute(path);
  const clean = (path.split("?")[0] ?? "").split("#")[0] ?? "";
  if (clean === "/privacy") return "/interest/privacy";
  return "/interest";
}
