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
 */
export function buildInterestListWelcomeEmail(input: { unsubscribeUrl: string }) {
  const appUrl = getAppBaseUrl();
  const signUpUrl = `${appUrl}/sign-up`;
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
    `Try it now: ${signUpUrl}`,
    "",
    "— Jason",
    "",
    "—",
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
            <tr>
              <td style="padding-bottom:30px;">
                <span style="font-size:19px;font-weight:600;color:${TEXT};letter-spacing:-0.01em;">Orbit</span>
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
            <tr>
              <td style="padding-top:10px;padding-bottom:30px;">
                <a href="${signUpUrl}"
                   style="display:inline-block;background-color:${ACCENT};color:${BG};font-weight:600;font-size:15px;text-decoration:none;padding:13px 26px;border-radius:10px;">
                  Try it now
                </a>
              </td>
            </tr>
            <tr>
              <td style="font-size:15px;line-height:1.65;color:${MUTED};padding-bottom:32px;">
                — Jason
              </td>
            </tr>
            <tr>
              <td style="font-size:12px;line-height:1.6;color:${FAINT};border-top:1px solid rgba(232,243,241,0.14);padding-top:22px;">
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
