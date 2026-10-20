import { NextResponse, type NextRequest } from "next/server";
import { unsubscribePage, unsubscribeTokenOf } from "@/lib/unsubscribe-page";
import { unsubscribeRadarDigest } from "@/lib/radar/digest";

// Clicked from Radar's Monday email, often in a mail client with no session. Authenticated
// by the signed token in the query string instead (`src/lib/radar/digest.ts`), the same
// shape as the waitlist's leave link.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function page(message: string, action?: { href: string; label: string }) {
  return unsubscribePage(message, action, "Radar email");
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
    page("Stop Radar’s Monday email? You can turn it back on in Settings.", { href: self, label: "Turn it off" }),
    { status: 200, headers: HTML_HEADERS }
  );
}

/**
 * The confirmation button, and RFC 8058 one-click unsubscribe: every digest sets
 * `List-Unsubscribe-Post`, which promises this URL accepts a POST, so Gmail's and Yahoo's own
 * unsubscribe buttons call it directly. The token is the whole request.
 */
export async function POST(request: NextRequest) {
  const token = unsubscribeTokenOf(request);
  if (!token) return new NextResponse(page("This link is missing its token."), { status: 400, headers: HTML_HEADERS });
  if (!(await unsubscribeRadarDigest(token))) {
    // The same answer whether the token was mistyped, forged or never issued.
    return new NextResponse(page("This link is invalid."), { status: 404, headers: HTML_HEADERS });
  }
  return new NextResponse(
    page("Done. Radar won’t email you on Mondays any more. Turn it back on any time in Settings."),
    { status: 200, headers: HTML_HEADERS }
  );
}
