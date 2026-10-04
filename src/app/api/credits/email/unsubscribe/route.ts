import { NextResponse, type NextRequest } from "next/server";
import { escapeHtml } from "@/lib/interest-list-email";
import { unsubscribeCreditEmail } from "@/lib/credits/notices";

// Clicked from a credit email (80% or 100% of the monthly AI credits), often in a mail client
// with no session. Authenticated by the signed token in the query string instead
// (`src/lib/credits/notices.ts`) — the same shape as Radar's Monday email's link.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function page(message: string, action?: { href: string; label: string }) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Orbit credit emails</title></head>
  <body style="margin:0;padding:0;background-color:#05070f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="min-height:100vh;">
      <tr>
        <td align="center" valign="middle" style="padding:40px 20px;">
          <table role="presentation" width="420" cellpadding="0" cellspacing="0" style="max-width:420px;width:100%;text-align:center;">
            <tr><td style="font-size:15px;line-height:1.6;color:#9aada8;">${message}</td></tr>
            ${
              action
                ? `<tr><td style="padding-top:22px;">
              <form method="post" action="${escapeHtml(action.href)}" style="margin:0;">
                <button type="submit" style="font:inherit;font-size:15px;font-weight:600;color:#05070f;background:#f2c14e;border:0;border-radius:10px;padding:12px 24px;cursor:pointer;">${escapeHtml(action.label)}</button>
              </form>
            </td></tr>`
                : ""
            }
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" };

function tokenOf(request: NextRequest) {
  return request.nextUrl.searchParams.get("token")?.trim() || null;
}

/**
 * The footer link opens a one-button confirmation, not an immediate change: link scanners
 * (Outlook Safe Links, corporate gateways) fetch every URL in a message before the person
 * sees it, and a GET that unsubscribed would quietly turn the email off for them. Nothing is
 * read or written on GET, so a bogus token learns nothing either.
 */
export async function GET(request: NextRequest) {
  const token = tokenOf(request);
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
  const token = tokenOf(request);
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
