import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { PUBLIC_ROUTES } from "@/lib/public-routes";
import { getAppBaseUrl } from "@/lib/app-url";
import { API_SIGNED_OUT_BODY, API_SIGNED_OUT_STATUS, isApiPath } from "@/lib/api-signed-out";
import { isLocalhost } from "@/lib/demo-account";
import { STEALTH_ROBOTS, isWaitlistHostHeader, stealthGate } from "@/lib/waitlist-host";
import { readStealthForProxy } from "@/lib/site-mode-proxy";
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

function withPathname(req: Request, options: { noindex?: boolean } = {}) {
  const requestHeaders = new Headers(req.headers);
  const url = new URL(req.url);
  requestHeaders.set("x-pathname", url.pathname);
  const res = NextResponse.next({
    request: { headers: requestHeaders },
  });
  if (options.noindex) res.headers.set("X-Robots-Tag", STEALTH_ROBOTS);
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
  // The Host header too, not only the request URL's: behind a proxy or on a second domain
  // (the waitlist's) the URL can carry the server's own host while the visitor's browser —
  // and so its referer — used the public one.
  const ownHosts = new Set([url.host, req.headers.get("host") ?? url.host]);
  let external: string | null = null;
  if (referer) {
    try {
      if (!ownHosts.has(new URL(referer).host)) external = referer;
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

/**
 * Stealth on the app host. A runtime switch (the admin console's, else `SITE_STEALTH`), read
 * per request from a short per-instance cache — see `src/lib/site-mode-proxy.ts`. The rules
 * themselves are `stealthGate` in `src/lib/waitlist-host.ts`; this only applies its answer.
 *
 * `signedIn` is a thunk so the session is read only when the answer depends on it: stealth
 * off, API calls and the always-open paths never pay for `auth()`.
 */
async function applyStealth(
  req: Request,
  signedIn: () => Promise<boolean>
): Promise<{ response: NextResponse | null; stealth: boolean }> {
  const stealth = await readStealthForProxy();
  if (!stealth) return { response: null, stealth };
  const url = new URL(req.url);
  const isApi = isApiPath(url.pathname);
  // Signed-out first: every rule that ignores the session answers the same either way, so
  // only a would-be redirect is worth confirming against the session.
  let gate = stealthGate({ pathname: url.pathname, search: url.search, signedIn: false, isApi });
  if (gate.kind === "redirect" && (await signedIn())) {
    gate = stealthGate({ pathname: url.pathname, search: url.search, signedIn: true, isApi });
  }
  if (gate.kind === "not-found") return { response: new NextResponse(null, { status: 404 }), stealth };
  if (gate.kind === "redirect") {
    const response = NextResponse.redirect(new URL(gate.to, req.url), 307);
    response.headers.set("X-Robots-Tag", STEALTH_ROBOTS);
    return { response, stealth };
  }
  return { response: null, stealth };
}

const appProxy = configured
  ? clerkMiddleware(
      async (auth, req) => {
        const { pathname } = new URL(req.url);
        const { response, stealth } = await applyStealth(req, async () => {
          try {
            return Boolean((await auth()).userId);
          } catch {
            return false;
          }
        });
        if (response) return response;
        if (!isPublicRoute(req)) {
          if (isApiPath(pathname)) {
            // API callers get JSON, never a redirect: a followed 307 hands them the sign-in
            // page as a 200 they cannot tell from success. `auth.protect()` is skipped here
            // because it treats every request inside the proxy as a page navigation.
            // Pending sessions read as signed out, as protect() would treat them.
            const { userId } = await auth();
            if (!userId) {
              return NextResponse.json(API_SIGNED_OUT_BODY, { status: API_SIGNED_OUT_STATUS });
            }
          } else {
            // Pages — and the server-action POSTs made to them — keep Clerk's behaviour.
            await auth.protect();
          }
        }
        return withPathname(req, { noindex: stealth });
      },
      authorizedParties.length > 0 ? { authorizedParties } : undefined
    )
  : async function middleware(req: Request) {
      if (process.env.NODE_ENV === "production") {
        return new NextResponse("Authentication is not configured", {
          status: 503,
        });
      }
      // Defense in depth for the admin console. Without Clerk keys this is demo mode, where
      // `requireUserId()` succeeds as the shared "demo-user" — so everywhere except a real
      // `next dev` worktree the route must be gone entirely, not merely unauthorized.
      // `src/lib/admin.ts` grants "demo-user" the same `isLocalhost()` exemption, so a
      // worktree with no `.env` can still reach the console; anything else Clerk-less
      // (a misconfigured deploy, `next start` locally, `NODE_ENV=test`) still 404s here.
      //
      // `/api/admin` is listed separately rather than caught by the same prefix: the export
      // handler lives under /api and would otherwise fall through this branch entirely.
      const { pathname } = new URL(req.url);
      // Without Clerk every visitor is the demo account, so stealth treats them as signed in.
      const { response, stealth } = await applyStealth(req, async () => true);
      if (response) return response;
      if (
        !isLocalhost() &&
        (pathname.startsWith("/admin") || pathname.startsWith("/api/admin"))
      ) {
        return new NextResponse(null, { status: 404 });
      }
      return withPathname(req, { noindex: stealth });
    };

/**
 * The waitlist host never reaches Clerk. Its every path is already allowlisted by the
 * config redirects (src/lib/waitlist-host.ts), none of its pages or routes need a session,
 * and Clerk's handshake would bounce a first visit through the app's own Clerk domain —
 * naming it in the address bar of someone who must never see it.
 */
export default function proxy(req: NextRequest, event: NextFetchEvent) {
  if (isWaitlistHostHeader(req.headers.get("host"))) return withPathname(req);
  return appProxy(req, event);
}

export const config = {
  matcher: [
    // The extension list is an allowlist of things middleware must NOT touch. A static
    // asset type missing from it is matched, fails `isPublicRoute`, and gets a 307 to
    // /sign-in instead of its bytes — so the file silently becomes an HTML sign-in page.
    // It fails in production only (locally `configured` is false and this branch is
    // skipped entirely), and for `<picture>` it is unrecoverable: once a <source> matches
    // by type the browser commits to that URL and never falls back to the <img>. That is
    // exactly how `avif` broke every planet on the marketing hero. Add new static
    // extensions here when you add them to public/.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|avif|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
