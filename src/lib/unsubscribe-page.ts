import { escapeHtml } from "@/lib/interest-list-email";

/**
 * The shared pieces of the three one-click unsubscribe routes (credit emails, Radar's Monday
 * email, the waitlist): a minimal confirmation page, and the `?token=` reader.
 */

/** The `?token=` query value, trimmed, or null when absent or blank. */
export function unsubscribeTokenOf(request: { nextUrl: { searchParams: URLSearchParams } }): string | null {
  return request.nextUrl.searchParams.get("token")?.trim() || null;
}

/**
 * A dark, single-message page with an optional one-button POST form. Pass `title` for a
 * branded page with a `<head>`; omit it for the deliberately unbranded waitlist page, which
 * has no head at all.
 */
export function unsubscribePage(
  message: string,
  action?: { href: string; label: string },
  title?: string
): string {
  const head = title
    ? `  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${title}</title></head>\n`
    : "";
  return `<!doctype html>
<html>
${head}  <body style="margin:0;padding:0;background-color:#05070f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
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
