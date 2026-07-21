import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isPublicRoute = createRouteMatcher([
  "/",
  "/privacy",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/webhooks(.*)",
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
      return withPathname(req);
    };

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
