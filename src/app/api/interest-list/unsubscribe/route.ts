import { eq, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { interestListSignups } from "@/db/schema";

// Clicked from an email by someone who has never signed in — authenticated by the opaque
// token in the query string, same pattern as the calendar feed's token-in-path route.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function page(message: string) {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:#05070f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="min-height:100vh;">
      <tr>
        <td align="center" valign="middle" style="padding:40px 20px;">
          <table role="presentation" width="420" cellpadding="0" cellspacing="0" style="max-width:420px;width:100%;text-align:center;">
            <tr><td style="font-size:18px;font-weight:600;color:#e8f3f1;padding-bottom:16px;">Orbit</td></tr>
            <tr><td style="font-size:15px;line-height:1.6;color:#9aada8;">${message}</td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" };

async function unsubscribe(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token")?.trim();
  if (!token) {
    return new NextResponse(page("This link is missing its token."), {
      status: 400,
      headers: HTML_HEADERS,
    });
  }

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
    page("You're unsubscribed. You won't hear from Orbit's interest list again."),
    { status: 200, headers: HTML_HEADERS }
  );
}

/** A person clicking the footer link in their mail client. */
export const GET = unsubscribe;

/**
 * RFC 8058 one-click unsubscribe. The welcome email sets `List-Unsubscribe-Post`, which
 * promises this URL accepts a POST — Gmail and Yahoo call it directly when someone uses
 * their built-in unsubscribe button, and would get a 405 if only GET existed.
 *
 * Same handler as GET on purpose: the token in the query string is the whole request, and
 * the spec's `List-Unsubscribe=One-Click` body carries nothing else worth reading.
 */
export const POST = unsubscribe;
