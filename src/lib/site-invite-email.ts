import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import { getAppBaseUrl } from "@/lib/app-url";
import { ACCENT, BG, FAINT, FONT_STACK, MUTED, TEXT, escapeHtml } from "@/lib/interest-list-email";
import type { WelcomePlanet } from "@/lib/welcome-planets";

/**
 * The admin invitation, as a boarding pass: the email that turns a waitlist wait into an
 * account. Sent by `inviteToSite` in place of Clerk's stock invitation email (Clerk is told
 * `notify: false`), so the link inside is still Clerk's own ticket URL.
 *
 * BRANDED, unlike the waitlist mail in `interest-list-email.ts`: this is the moment someone
 * is let into the product, so it names Orbit and comes from the app's sender. It borrows
 * the waitlist's palette and planet on purpose — someone who waited sees their own planet
 * again, now on a pass that boards.
 *
 * Inline styles and nested tables throughout, for the same reason as the waitlist shell:
 * clients strip `<style>` and ignore CSS grid. Fraunces is named first for the clients that
 * have it and falls back to Georgia; nothing depends on it loading. Both images are
 * decorative (empty alt), so a client that blocks images still gets the whole message.
 */

export type SiteInviteEmailKind = "invite" | "existing-account";

/** A waitlist entry's planet when there is one; direct invites get the home planet. */
export const DEFAULT_INVITE_PLANET: WelcomePlanet = "earth";

const SIGNATURE = "Jason";
const PASS_BG = "#0e1524";
const PASS_BORDER = "#333f5a";

const label = (text: string) =>
  `<div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:${FAINT};padding-bottom:3px;">${text}</div>`;

const field = (name: string, value: string, color = TEXT) =>
  `<td valign="top" width="50%" style="padding:0 8px 16px 0;">
                      ${label(name)}
                      <div style="font-size:15px;line-height:1.4;color:${color};word-break:break-word;">${value}</div>
                    </td>`;

function formatBoardBy(date: Date) {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function buildSiteInviteEmail(input: {
  email: string;
  url: string;
  kind: SiteInviteEmailKind;
  planet: WelcomePlanet;
  firstName?: string | null;
  /** When the link stops working. Omitted for the existing-account sign-in link, which doesn't. */
  expiresAt?: Date | null;
}) {
  const base = getAppBaseUrl();
  const firstName = input.firstName?.trim() || null;
  const existing = input.kind === "existing-account";
  const boardBy = !existing && input.expiresAt ? formatBoardBy(input.expiresAt) : null;

  const subject = "Now boarding: your Orbit pass";
  const lead = firstName ? `Your wait is over, ${firstName}.` : "Your wait is over.";
  const opening = existing
    ? "I've opened Orbit up for your account — the full plan, on me. Sign in with this address and you're through."
    : "I've opened a seat on Orbit for you — the full plan, on me. Your pass is below.";
  const buttonLabel = existing ? "Sign in to Orbit" : "Board Orbit";
  const fineprint = existing
    ? `Sign in as ${input.email} to board. Not expecting this? You can ignore it.`
    : `This pass works once and creates an account for ${input.email}. Not expecting it? Ignore this email — nothing happens until you board.`;

  const e = escapeHtml;
  const planetUrl = `${base}/landing/planets/${input.planet}.png`;
  const logoUrl = `${base}/orbit-logo.png`;

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:${BG};font-family:${FONT_STACK};">
    <span style="display:none;font-size:1px;color:${BG};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
      ${e(`${lead} One seat on Orbit, everything included.`)}
    </span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BG};">
      <tr>
        <td align="center" style="padding:36px 20px 40px;">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
            <tr>
              <td style="padding-bottom:26px;">
                <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                  <td style="padding-right:9px;vertical-align:middle;">
                    <img src="${e(logoUrl)}" alt="" width="24" height="24" style="display:block;border:0;outline:none;width:24px;height:24px;" />
                  </td>
                  <td style="vertical-align:middle;font-family:'Fraunces', Georgia, serif;font-size:19px;color:${TEXT};">Orbit</td>
                </tr></table>
              </td>
            </tr>
            <tr>
              <td style="font-family:'Fraunces', Georgia, serif;font-size:24px;line-height:1.3;color:${TEXT};padding-bottom:12px;">${e(lead)}</td>
            </tr>
            <tr>
              <td style="font-size:15px;line-height:1.65;color:${MUTED};padding-bottom:24px;">${e(opening)}</td>
            </tr>
            <tr>
              <td>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                       style="background-color:${PASS_BG};border:1px solid ${PASS_BORDER};border-radius:18px;border-collapse:separate;">
                  <tr>
                    <td align="center" style="padding:28px 22px 20px;">
                      <img src="${e(planetUrl)}" alt="" width="76" height="76" style="display:block;border:0;outline:none;width:76px;height:76px;" />
                      <div style="font-family:'Fraunces', Georgia, serif;font-size:24px;line-height:1.3;color:${TEXT};padding-top:16px;">You're cleared to board</div>
                      <div style="font-size:14px;line-height:1.5;color:${MUTED};padding-top:4px;">One seat, everything included.</div>
                    </td>
                  </tr>
                  <tr>
                    <td style="border-top:1px dashed ${PASS_BORDER};padding:20px 22px 4px;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                    ${field("Passenger", e(input.email))}
                    ${field("Class", "Orbit · full access", ACCENT)}
                        </tr>
                        <tr>
                    ${field("Invited by", SIGNATURE)}
                    ${boardBy ? field("Board by", e(boardBy)) : field("Gate", "Sign in")}
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:4px 22px 22px;">
                      <a href="${e(input.url)}"
                         style="display:block;text-align:center;background-color:${ACCENT};color:${BG};font-weight:600;font-size:15px;text-decoration:none;padding:14px 0;border-radius:10px;">
                        ${e(buttonLabel)}
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="font-size:15px;line-height:1.65;color:${MUTED};padding-top:24px;padding-bottom:24px;">— ${SIGNATURE}</td>
            </tr>
            <tr>
              <td style="font-size:12px;line-height:1.6;color:${FAINT};border-top:1px solid rgba(232,243,241,0.14);padding-top:18px;">
                ${e(fineprint)}<br />
                Button not working? Paste this link into your browser:<br />
                <a href="${e(input.url)}" style="color:${FAINT};text-decoration:underline;word-break:break-all;">${e(input.url)}</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    lead,
    "",
    opening,
    "",
    "YOUR ORBIT PASS",
    `Passenger: ${input.email}`,
    "Class: Orbit · full access",
    `Invited by: ${SIGNATURE}`,
    ...(boardBy ? [`Board by: ${boardBy}`] : []),
    "",
    `${buttonLabel}: ${input.url}`,
    "",
    `— ${SIGNATURE}`,
    "",
    "—",
    fineprint,
  ].join("\n");

  return { subject, html, text };
}

/**
 * Who the invitation is from: the app's sender (`RESEND_FROM_EMAIL`), named "Orbit" when
 * it is a bare address. Never the waitlist sender — that one must not name the product,
 * and this email does.
 */
export function siteInviteSender(): string | null {
  const configured = process.env.RESEND_FROM_EMAIL?.trim();
  if (!configured) return null;
  return configured.includes("<") ? configured : `Orbit <${configured}>`;
}

/**
 * Never throws. Returns whether Resend accepted the message, which the admin console shows:
 * the invitation itself already exists in Clerk, so a failed send means "copy the link",
 * not "try again".
 */
export async function sendSiteInviteEmail(
  message: { subject: string; html: string; text: string },
  to: string
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = siteInviteSender();
  if (!apiKey || !from) {
    console.warn("[site-invites] Resend not configured — skipping the invitation email");
    return false;
  }

  try {
    const { Resend } = await import("resend");
    const { error } = await new Resend(apiKey).emails.send({
      from,
      to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      // Signed "— Jason", so a reply should reach him rather than a no-reply box.
      replyTo: process.env.WAITLIST_REPLY_TO?.trim() || undefined,
    });
    if (error) {
      console.error("[site-invites] Resend rejected the invitation email", error);
      await recordErrorEvent({
        source: ERROR_SOURCES.resendRejected,
        kind: "site.invite",
        message: error,
        context: { phase: "rejected", name: error.name },
      });
      return false;
    }
    return true;
  } catch (err) {
    console.error("[site-invites] Failed to send the invitation email", err);
    await recordErrorEvent({
      source: ERROR_SOURCES.resendRejected,
      kind: "site.invite",
      message: err,
      context: { phase: "threw" },
    });
    return false;
  }
}
