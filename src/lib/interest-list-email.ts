import { randomBytes } from "node:crypto";
import { Resend } from "resend";
import { getAppBaseUrl } from "@/lib/app-url";
import { FREE_CONTACT_LIMIT } from "@/lib/plan-limits";

/** Opaque, same convention as `generateCalendarFeedToken` — no session, no guessable id. */
export function generateUnsubscribeToken() {
  return randomBytes(32).toString("base64url");
}

export function buildUnsubscribeUrl(token: string) {
  return `${getAppBaseUrl()}/api/interest-list/unsubscribe?token=${token}`;
}

const BG = "#05070f";
const TEXT = "#e8f3f1";
const MUTED = "#9aada8";
const FAINT = "#6d807c";
const ACCENT = "#f2c14e";
const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The one email this list sends today.
 *
 * WRITTEN AS A PERSONAL NOTE, not a product announcement: the list is small and Orbit is a
 * one-person project, so a branded blast would read as overproduced. `/contact` already sets
 * this expectation ("expect a reply from Jason"), and the send below sets a matching From
 * name and a real Reply-To so the signature is not a costume.
 *
 * IT OPENS BY ADMITTING IT IS NOT THE NEWS. The landing page's confirmation promises "we'll
 * email you when there's news", and this lands seconds later — so it names itself as the
 * hello up front rather than letting an immediate arrival read as a broken promise.
 *
 * The one thing it does argue: there is nothing to wait for. Someone who chose the email box
 * over the sign-up button may believe Orbit is unreleased, and that belief is simply wrong.
 *
 * Inline styles and a table shell rather than a stylesheet: most email clients strip
 * `<style>` blocks or run them through their own reset, so anything that matters is written
 * on the element itself. Kept to a single column and web-safe fonts for the same reason —
 * the display face the landing page uses is not reliably available in mail clients.
 *
 * GRAPHICS ARE BUILT TO SURVIVE BLOCKED IMAGES, which Outlook and many Gmail configurations
 * do by default until the reader clicks "show images". So nothing load-bearing is carried by
 * an `<img>`: the logo sits beside a real text wordmark, the product card below is drawn with
 * table cells and background colours rather than a screenshot, and the planet is decorative
 * with empty alt text. Inline SVG and `data:` URIs are both unusable here — Gmail strips the
 * former and blocks the latter — so every real image is a hosted PNG at an absolute URL.
 */
export function buildInterestListWelcomeEmail(input: { unsubscribeUrl: string }) {
  const appUrl = getAppBaseUrl();
  const signUpUrl = `${appUrl}/sign-up`;
  const logoUrl = `${appUrl}/orbit-logo.png`;
  const saturnUrl = `${appUrl}/landing/planets/saturn.png`;
  const subject = "You're on the Orbit list";

  const text = [
    "You're on the list.",
    "",
    "This one's just the hello — the actual news will come later, and not often.",
    "",
    `Though there is one thing worth saying now: Orbit is already live. No waitlist to clear, no invite to wait for. It's free for your first ${FREE_CONTACT_LIMIT} contacts.`,
    "",
    "If you're interviewing at the moment, that's when it earns its keep — it's built so the person who could refer you doesn't go cold while you're busy with everything else.",
    "",
    "    Priya Raman",
    "    Referral call · 3 weeks ago · no follow-up sent",
    "    → Follow up today",
    "",
    `Try it now: ${signUpUrl}`,
    "",
    "— Jason",
    "",
    "—",
    "You're getting this because you joined Orbit's interest list.",
    `Unsubscribe any time: ${input.unsubscribeUrl}`,
  ].join("\n");

  const paragraph = (content: string) =>
    `<tr><td style="font-size:15px;line-height:1.65;color:${MUTED};padding-bottom:18px;">${content}</td></tr>`;

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:${BG};font-family:${FONT_STACK};">
    <span style="display:none;font-size:1px;color:${BG};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
      Orbit's already live — there's nothing to wait for.
    </span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BG};">
      <tr>
        <td align="center" style="padding:40px 20px;">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
            <!-- Logo lockup. The wordmark is real text beside the mark, so a client with
                 images off still shows "Orbit" rather than an empty box. -->
            <tr>
              <td style="padding-bottom:30px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <!-- alt="" on purpose: the wordmark beside it is real text, so the mark
                         is redundant. Giving it alt="Orbit" renders "Orbit Orbit" (plus a
                         broken-image glyph) in every client that blocks images. -->
                    <td style="padding-right:11px;" valign="middle">
                      <img src="${logoUrl}" alt="" width="40" height="40"
                           style="display:block;border:0;outline:none;text-decoration:none;width:40px;height:40px;border-radius:50%;" />
                    </td>
                    <td valign="middle">
                      <span style="font-size:20px;font-weight:600;color:${TEXT};letter-spacing:-0.01em;">Orbit</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="font-size:21px;line-height:1.35;color:${TEXT};font-weight:600;padding-bottom:18px;">
                You're on the list.
              </td>
            </tr>
            ${paragraph("This one's just the hello — the actual news will come later, and not often.")}
            ${paragraph(
              `Though there is one thing worth saying now: Orbit is <strong style="color:${TEXT};font-weight:600;">already live</strong>. No waitlist to clear, no invite to wait for. It's free for your first ${FREE_CONTACT_LIMIT} contacts.`
            )}
            ${paragraph(
              "If you're interviewing at the moment, that's when it earns its keep — it's built so the person who could refer you doesn't go cold while you're busy with everything else."
            )}
            <!-- The product moment, drawn rather than screenshotted: table cells and
                 background colours render with images blocked, and stay crisp on any DPI.
                 Mirrors the card on the landing page's "Before it goes cold" scene. -->
            <tr>
              <td style="padding-top:6px;padding-bottom:28px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                       style="background-color:#0a0f1c;border:1px solid rgba(232,243,241,0.12);border-radius:14px;">
                  <tr>
                    <td style="padding:16px 18px;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                        <tr>
                          <td width="40" valign="middle" style="padding-right:12px;">
                            <table role="presentation" width="40" height="40" cellpadding="0" cellspacing="0" border="0"
                                   style="background-color:#0f3d3e;border-radius:50%;">
                              <tr>
                                <td align="center" valign="middle"
                                    style="font-size:13px;font-weight:600;color:${TEXT};height:40px;">PR</td>
                              </tr>
                            </table>
                          </td>
                          <td valign="middle">
                            <div style="font-size:14px;font-weight:600;color:${TEXT};">Priya Raman</div>
                            <div style="font-size:12px;color:${MUTED};padding-top:3px;">Referral call · 3 weeks ago · no follow-up sent</div>
                          </td>
                        </tr>
                      </table>
                      <div style="font-size:12px;font-weight:600;color:${ACCENT};background-color:rgba(242,193,78,0.13);border-radius:999px;padding:6px 12px;margin-top:14px;display:inline-block;">
                        Follow up today
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:30px;">
                <a href="${signUpUrl}"
                   style="display:inline-block;background-color:${ACCENT};color:${BG};font-weight:600;font-size:15px;text-decoration:none;padding:13px 26px;border-radius:10px;">
                  Try it now
                </a>
              </td>
            </tr>
            <!-- Signature, with the planet as a right-aligned flourish. Sharing the row is
                 deliberate: on its own line a blocked image leaves a conspicuous empty
                 placeholder box, whereas here it degrades to whitespace beside the sign-off.
                 Decorative, so alt="". -->
            <tr>
              <td style="padding-bottom:26px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td valign="middle" style="font-size:15px;line-height:1.65;color:${MUTED};">
                      — Jason
                    </td>
                    <td align="right" valign="middle">
                      <img src="${saturnUrl}" alt="" width="38" height="38"
                           style="display:block;border:0;outline:none;width:38px;height:38px;opacity:0.8;" />
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="font-size:12px;line-height:1.6;color:${FAINT};border-top:1px solid rgba(232,243,241,0.14);padding-top:22px;">
                You're getting this because you joined Orbit's interest list.
                <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:${FAINT};text-decoration:underline;">Unsubscribe any time</a>.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, html, text };
}

/**
 * A personal note should look like it came from a person in the inbox list, not from a
 * no-reply robot. Only wraps a bare address: a RESEND_FROM_EMAIL that already carries its
 * own display name (`Orbit <hi@…>`) is left exactly as configured.
 */
function fromAddress() {
  const configured = process.env.RESEND_FROM_EMAIL?.trim();
  if (!configured) return null;
  return configured.includes("<") ? configured : `Jason from Orbit <${configured}>`;
}

/**
 * Best-effort. The signup itself is already durable in `interest_list_signups` by the time
 * this runs, so a Resend outage or a missing API key should never turn a successful signup
 * into a failed one — this only ever logs.
 */
export async function sendInterestListWelcomeEmail(email: string, unsubscribeUrl: string) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = fromAddress();
  if (!apiKey || !from) {
    console.warn("[interest-list] Resend not configured — skipping welcome email");
    return;
  }

  try {
    const { subject, html, text } = buildInterestListWelcomeEmail({ unsubscribeUrl });
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from,
      to: email,
      subject,
      html,
      text,
      // Signed "— Jason", so a reply has to reach one. Falls back to the From address when
      // no contact inbox is configured rather than inventing a destination.
      replyTo: process.env.CONTACT_INBOX_EMAIL?.trim() || undefined,
      headers: {
        // One-click unsubscribe. Gmail and Yahoo require this on bulk mail, and without it
        // the only way out is the footer link — which recipients skip in favour of "spam",
        // and that is the signal that poisons a sending domain.
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    if (error) {
      console.error("[interest-list] Resend rejected the welcome email", error);
    }
  } catch (err) {
    console.error("[interest-list] Failed to send the welcome email", err);
  }
}
