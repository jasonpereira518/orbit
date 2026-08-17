import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isPublicRoute = createRouteMatcher([
  "/",
  "/privacy",
  "/terms",
  "/contact",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/webhooks(.*)",
  // Not actually public: these authenticate via requireExtensionUserId, which
  // reads the Clerk state clerkMiddleware populates below. They are exempted
  // from auth.protect() only so an unauthenticated call gets a JSON 401 the
  // extension can act on, rather than a 302 to an HTML sign-in page.
  "/api/extension(.*)",
]);

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
 * its stable ID (pinned by the `key` field in its manifest), and
 * NEXT_PUBLIC_APP_URL must match the host users actually browse.
 */
const extensionOrigins = (process.env.EXTENSION_ORIGIN ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const authorizedParties =
  extensionOrigins.length > 0
    ? [...extensionOrigins, process.env.NEXT_PUBLIC_APP_URL?.trim()].filter(
        (value): value is string => Boolean(value)
      )
    : [];

function withPathname(req: Request) {
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-pathname", new URL(req.url).pathname);
  return NextResponse.next({
    request: { headers: requestHeaders },
  });
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
      return withPathname(req);
    };

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
