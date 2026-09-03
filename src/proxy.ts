import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { PUBLIC_ROUTES } from "@/lib/public-routes";
import { getAppBaseUrl } from "@/lib/app-url";
import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_MAX_AGE_S,
  attributionFromUrl,
  hasSignal,
  serializeAttribution,
} from "@/lib/attribution-parse";

// The list lives in `@/lib/public-routes` so a smoke test can assert it against the
// filesystem — a marketing page missing from it 404s for exactly the people it is for.
const isPublicRoute = createRouteMatcher([...PUBLIC_ROUTES]);

const configured = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

/**
 * Origins allowed to present a Clerk session to this app.
 *
 * Opt-in, and deliberately gated on EXTENSION_ORIGIN being set: passing
 * `authorizedParties` replaces Clerk's default origin check entirely, so an
 * incomplete list locks users out. Preview deployments in particular get a
 * dynamic *.vercel.app host that no static list can predict — so unless the
 * extension is actually configured, we leave Clerk's default behavior alone.
 *
 * When it is set, EXTENSION_ORIGIN is the extension's own origin, derived from
 * its stable ID (pinned by the `key` field in its manifest). The host users
 * actually browse is re-included via `getAppBaseUrl()` (APP_BASE_URL, or the
 * project's production domain on Vercel) — forgetting it would lock every
 * normal browser session out of the app.
 */
const extensionOrigins = (process.env.EXTENSION_ORIGIN ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const authorizedParties =
  extensionOrigins.length > 0 ? [...extensionOrigins, getAppBaseUrl()] : [];

function withPathname(req: Request) {
  const requestHeaders = new Headers(req.headers);
  const url = new URL(req.url);
  requestHeaders.set("x-pathname", url.pathname);
  const res = NextResponse.next({
    request: { headers: requestHeaders },
  });
  return withFirstTouch(req, url, res);
}

/**
 * Capture where this browser came from, once, on its very first request.
 *
 * MIDDLEWARE RATHER THAN A PAGE, for a mundane reason: a server component cannot set a
 * cookie in Next, so the marketing pages physically cannot do this themselves. Middleware
 * runs before all of them and sees the external `referer` header that only exists on the
 * first hop — one request later it has already been replaced by Orbit's own URL.
 *
 * FIRST TOUCH WINS: if the cookie is already set, this does nothing. A visitor who arrives
 * from Reddit, reads for a week and signs up after a direct visit was acquired by Reddit,
 * and overwriting here would credit "direct" and erase the only channel that worked.
 *
 * Same-origin referrers are dropped before anything else. Without that, the second page
 * anyone views would attribute them to orbit itself, and every internal navigation would
 * look like a channel.
 */
function withFirstTouch(req: Request, url: URL, res: NextResponse) {
  if (req.headers.get("cookie")?.includes(`${ATTRIBUTION_COOKIE}=`)) return res;

  const referer = req.headers.get("referer");
  let external: string | null = null;
  if (referer) {
    try {
      if (new URL(referer).host !== url.host) external = referer;
    } catch {
      // Unparseable referer — treat as absent rather than guessing.
    }
  }

  const attribution = attributionFromUrl(url.toString(), external);
  if (!hasSignal(attribution)) return res;

  res.cookies.set(ATTRIBUTION_COOKIE, serializeAttribution(attribution), {
    maxAge: ATTRIBUTION_MAX_AGE_S,
    sameSite: "lax",
    httpOnly: true,
    path: "/",
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}

export default configured
  ? clerkMiddleware(
      async (auth, req) => {
        if (!isPublicRoute(req)) {
          await auth.protect();
        }
        return withPathname(req);
      },
      authorizedParties.length > 0 ? { authorizedParties } : undefined
    )
  : function middleware(req: Request) {
      if (process.env.NODE_ENV === "production") {
        return new NextResponse("Authentication is not configured", {
          status: 503,
        });
      }
      // Defense in depth for the admin console. Without Clerk keys this is demo mode, where
      // `requireUserId()` succeeds as the shared "demo-user" — so the route must be gone
      // entirely, not merely unauthorized. `src/lib/admin.ts` denies it independently.
      //
      // `/api/admin` is listed separately rather than caught by the same prefix: the export
      // handler lives under /api and would otherwise fall through this branch entirely.
      const { pathname } = new URL(req.url);
      if (pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) {
        return new NextResponse(null, { status: 404 });
      }
      return withPathname(req);
    };

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
