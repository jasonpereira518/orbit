import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { PUBLIC_ROUTES } from "@/lib/public-routes";

// The list lives in `@/lib/public-routes` so a smoke test can assert it against the
// filesystem — a marketing page missing from it 404s for exactly the people it is for.
const isPublicRoute = createRouteMatcher([...PUBLIC_ROUTES]);

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
