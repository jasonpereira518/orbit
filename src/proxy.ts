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
 * Origins allowed to present a Clerk session to this app. The browser
 * extension's origin comes from its stable ID (pinned by the `key` field in its
 * manifest), so it has to be configured rather than inferred.
 */
const authorizedParties = [
  process.env.NEXT_PUBLIC_APP_URL,
  process.env.EXTENSION_ORIGIN,
]
  .map((value) => value?.trim())
  .filter((value): value is string => Boolean(value));

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
