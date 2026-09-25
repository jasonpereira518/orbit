import { eq, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { interestListSignups } from "@/db/schema";
import { escapeHtml } from "@/lib/interest-list-email";

// Clicked from an email by someone who has never signed in — authenticated by the opaque
// token in the query string, same pattern as the calendar feed's token-in-path route.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Deliberately unbranded, like everything on the waitlist's domain: no product name, no
 * link anywhere. See `lib/waitlist-host.ts`.
 */
function page(message: string, action?: { href: string; label: string }) {
  return `<!doctype html>
<html>
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

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" };

function tokenOf(request: NextRequest) {
  return request.nextUrl.searchParams.get("token")?.trim() || null;
}

function missingToken() {
  return new NextResponse(page("This link is missing its token."), {
    status: 400,
    headers: HTML_HEADERS,
  });
}

/**
 * A person clicking the footer link in their mail client gets a one-button confirmation,
 * NOT an immediate removal. On a waitlist, leaving costs a place in line, and link
 * scanners (Outlook Safe Links, corporate gateways) fetch every URL in a message before
 * the recipient ever sees it — a GET that unsubscribed would quietly take people off the
 * list. The button POSTs back here. Nothing is read or written on GET, so a bogus token
 * learns nothing either.
 */
export async function GET(request: NextRequest) {
  const token = tokenOf(request);
  if (!token) return missingToken();
  const self = `${request.nextUrl.pathname}?token=${encodeURIComponent(token)}`;
  return new NextResponse(
    page("Leave the waitlist? You'll lose your place in line.", { href: self, label: "Leave the waitlist" }),
    { status: 200, headers: { ...HTML_HEADERS, "Cache-Control": "private, no-store" } }
  );
}

async function unsubscribe(request: NextRequest) {
  const token = tokenOf(request);
  if (!token) return missingToken();

  const db = await getDb();
  // COALESCE rather than an unconditional `now()`: clicking an already-used unsubscribe
  // link (a second click, a mail client that pre-fetches links) must not keep pushing the
  // timestamp forward — the first click is the one that matters.
  const rows = await db
    .update(interestListSignups)
    .set({ unsubscribedAt: sql`coalesce(${interestListSignups.unsubscribedAt}, now())` })
    .where(eq(interestListSignups.unsubscribeToken, token))
    .returning();

  if (!rows[0]) {
    // 404 rather than a more specific error: this endpoint answers with the same shape
    // whether the token was mistyped or never existed, revealing nothing about validity.
    return new NextResponse(page("This link is invalid."), {
      status: 404,
      headers: HTML_HEADERS,
    });
  }

  return new NextResponse(
    page("You've left the waitlist. You won't hear from us again."),
    { status: 200, headers: HTML_HEADERS }
  );
}

/**
 * The confirmation button above, and RFC 8058 one-click unsubscribe: every waitlist email
 * sets `List-Unsubscribe-Post`, which promises this URL accepts a POST — Gmail and Yahoo
 * call it directly when someone uses their built-in unsubscribe button. The token in the
 * query string is the whole request; the spec's `List-Unsubscribe=One-Click` body carries
 * nothing else worth reading.
 */
export const POST = unsubscribe;
