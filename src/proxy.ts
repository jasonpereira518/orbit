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
  // Calendar clients (Google, Apple, Outlook) cannot complete a Clerk session. The feed
  // is authenticated by the opaque token in its path instead.
  "/api/calendar/(.*)",
]);

const configured = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

function withPathname(req: Request) {
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-pathname", new URL(req.url).pathname);
  return NextResponse.next({
    request: { headers: requestHeaders },
  });
}

export default configured
  ? clerkMiddleware(async (auth, req) => {
      if (!isPublicRoute(req)) {
        await auth.protect();
      }
      return withPathname(req);
    })
  : function middleware(req: Request) {
      if (process.env.NODE_ENV === "production") {
        return new NextResponse("Authentication is not configured", {
          status: 503,
        });
      }
      // Defense in depth for the admin console. Without Clerk keys this is demo mode, where
      // `requireUserId()` succeeds as the shared "demo-user" — so the route must be gone
      // entirely, not merely unauthorized. `src/lib/admin.ts` denies it independently.
      if (new URL(req.url).pathname.startsWith("/admin")) {
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
