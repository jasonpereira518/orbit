import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isDemoMode } from "@/lib/auth";
import { attributionFromUrl, referrerHost } from "@/lib/attribution-parse";
import { isBotUserAgent } from "@/lib/analytics-bots";
import { isTrackedPath, normalizeRoute } from "@/lib/analytics-routes";
import {
  analyticsEnabled,
  deviceFromUserAgent,
  hashVisitor,
} from "@/lib/analytics-visitor";
import { recordDwell, recordPageView } from "@/lib/page-views";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Traffic ingest. The client beacon in `src/components/analytics/pageview-beacon.tsx`
 * POSTs one of these per page view, then POSTs a `dwell` for it on the way out.
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
 * Per-instance abuse guard, keyed on the visitor hash.
 *
 * Deliberately in memory rather than `rate_limit_buckets`: that limiter costs a Postgres
 * upsert per check, which would double the write volume of the entire pipeline to police
 * it. Fluid Compute reuses instances, so a Map is good enough for the only threat that
 * matters here — someone curling the endpoint in a loop to poison the numbers.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
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

function clientIp(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
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
  if (!analyticsEnabled()) return OK();

  try {
    const body = (await request.json().catch(() => null)) as {
      kind?: unknown;
      id?: unknown;
      sessionId?: unknown;
      path?: unknown;
      url?: unknown;
      referrer?: unknown;
      dwellMs?: unknown;
    } | null;

    if (!body || !isUuid(body.id)) return OK();

    // Time-on-page, sent by `sendBeacon` as the page goes away.
    if (body.kind === "dwell") {
      if (typeof body.dwellMs === "number") await recordDwell(body.id, body.dwellMs);
      return OK();
    }

    if (!isUuid(body.sessionId)) return OK();
    if (typeof body.path !== "string" || !isTrackedPath(body.path)) return OK();

    const headers = request.headers;
    const userAgent = headers.get("user-agent") ?? "";
    const visitorHash = hashVisitor(clientIp(headers), userAgent);

    if (overRateLimit(visitorHash, Date.now())) return OK();

    // The client sends its full URL so the UTMs can be read here rather than trusted from
    // it. `attributionFromUrl` and `referrerHost` are the same parsers the signup
    // attribution cookie uses, so a campaign is spelled identically in both places — and
    // `referrerHost` already drops same-origin, which is what stops every internal
    // navigation from registering as a referral.
    const url = typeof body.url === "string" ? body.url : "";
    const referrer = typeof body.referrer === "string" ? body.referrer : null;
    const attribution = attributionFromUrl(url, referrer);
    const geo = geoFrom(headers);

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

    await recordPageView({
      id: body.id,
      visitorHash,
      sessionId: body.sessionId,
      userId,
      route: normalizeRoute(body.path),
      referrerHost: attribution.referrer ?? referrerHost(referrer),
      utmSource: attribution.utmSource,
      utmMedium: attribution.utmMedium,
      utmCampaign: attribution.utmCampaign,
      country: geo.country,
      region: geo.region,
      city: geo.city,
      device: deviceFromUserAgent(userAgent),
      isBot: isBotUserAgent(userAgent),
    });
  } catch {
    // A malformed beacon, a database blip, a missing salt mid-flight. None of it is the
    // visitor's problem and none of it is worth an error event.
  }

  return OK();
}
