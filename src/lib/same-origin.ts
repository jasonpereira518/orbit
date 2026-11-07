import { NextResponse } from "next/server";

/**
 * A 403 for a cookie-authenticated request from another site, or null to carry on.
 *
 * Server Actions refuse a cross-site Origin on their own; a route handler that stands in for
 * one (so a poll stops holding the tab's one-at-a-time action queue) has to say it itself.
 * Same comparison as `/api/contacts/avatar-backfill`: no Origin (same-origin GET-style
 * fetches from older browsers) is allowed, a mismatched one is not.
 */
export function refuseCrossOrigin(request: Request): NextResponse | null {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (origin && host && URL.parse(origin)?.host !== host) {
    return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 });
  }
  return null;
}
