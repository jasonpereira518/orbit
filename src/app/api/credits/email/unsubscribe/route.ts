import { NextResponse, type NextRequest } from "next/server";
import { unsubscribePage, unsubscribeTokenOf } from "@/lib/unsubscribe-page";
import { unsubscribeCreditEmail } from "@/lib/credits/notices";

// Clicked from a credit email (80% or 100% of the monthly AI credits), often in a mail client
// with no session. Authenticated by the signed token in the query string instead
// (`src/lib/credits/notices.ts`) — the same shape as Radar's Monday email's link.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function page(message: string, action?: { href: string; label: string }) {
  return unsubscribePage(message, action, "Orbit credit emails");
}

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" };

/**
 * The footer link opens a one-button confirmation, not an immediate change: link scanners
 * (Outlook Safe Links, corporate gateways) fetch every URL in a message before the person
 * sees it, and a GET that unsubscribed would quietly turn the email off for them. Nothing is
 * read or written on GET, so a bogus token learns nothing either.
 */
export async function GET(request: NextRequest) {
  const token = unsubscribeTokenOf(request);
  if (!token) return new NextResponse(page("This link is missing its token."), { status: 400, headers: HTML_HEADERS });
  const self = `${request.nextUrl.pathname}?token=${encodeURIComponent(token)}`;
  return new NextResponse(
    page("Stop the emails about your AI credits running low? You can turn them back on in Settings.", { href: self, label: "Turn them off" }),
    { status: 200, headers: HTML_HEADERS }
  );
}

/**
 * The confirmation button, and RFC 8058 one-click unsubscribe: every credit email sets
 * `List-Unsubscribe-Post`, which promises this URL accepts a POST, so Gmail's and Yahoo's own
 * unsubscribe buttons call it directly. The token is the whole request.
 */
export async function POST(request: NextRequest) {
  const token = unsubscribeTokenOf(request);
  if (!token) return new NextResponse(page("This link is missing its token."), { status: 400, headers: HTML_HEADERS });
  if (!(await unsubscribeCreditEmail(token))) {
    // The same answer whether the token was mistyped, forged or never issued.
    return new NextResponse(page("This link is invalid."), { status: 404, headers: HTML_HEADERS });
  }
  return new NextResponse(
    page("Done. Orbit won’t email you about your AI credits any more. Turn it back on any time in Settings."),
    { status: 200, headers: HTML_HEADERS }
  );
}
