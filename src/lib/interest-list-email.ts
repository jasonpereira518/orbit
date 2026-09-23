import { randomBytes } from "node:crypto";
import { Resend } from "resend";
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import { getWaitlistOrigin } from "@/lib/app-url";
import { formatTicketNumber, FRONT_WAVE_REFERRALS } from "@/lib/interest-list";
import { waitlistHost } from "@/lib/waitlist-host";
import type { WelcomePlanet } from "@/lib/welcome-planets";

// Re-exported so existing importers keep working; the definitions moved to a client-safe
// module because the pass needs them in the browser.
export {
  WELCOME_PLANETS,
  asWelcomePlanet,
  planetForSignupNumber,
  type WelcomePlanet,
} from "@/lib/welcome-planets";

/** The two personal links a signup gets once it has a share token. */
export type EmailLinks = { ticketUrl: string; shareUrl: string };

/** Opaque, same convention as `generateCalendarFeedToken` — no session, no guessable id. */
export function generateUnsubscribeToken() {
  return randomBytes(32).toString("base64url");
}

/** The leave link. On the waitlist's own domain, like everything else in these emails. */
export function buildUnsubscribeUrl(token: string) {
  return `${getWaitlistOrigin()}/api/interest-list/unsubscribe?token=${token}`;
}

export const BG = "#05070f";
export const TEXT = "#e8f3f1";
export const MUTED = "#9aada8";
export const FAINT = "#6d807c";
export const ACCENT = "#f2c14e";
export const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The footer every waitlist email ends with. */
export const WAITLIST_FOOTER = "You're getting this because you joined the waitlist.";

const paragraph = (content: string) =>
  `<tr><td style="font-size:15px;line-height:1.65;color:${MUTED};padding-bottom:18px;">${content}</td></tr>`;

/**
 * The shell every waitlist email shares: the planet as a small decorative mark, a
 * headline, the body rows, the sign-off and the leave link.
 *
 * UNBRANDED ON PURPOSE. The waitlist does not name the product, show its logo, link to its
 * domain or describe what it does (see `lib/waitlist-host.ts`), and an email is the easiest
 * thing in the world to forward — so these carry no name but Jason's, no image but the
 * planet, and no link that is not on the waitlist's own domain.
 *
 * Inline styles and a table shell rather than a stylesheet: most email clients strip
 * `<style>` blocks. Nothing load-bearing is carried by the one `<img>` — the planet is
 * decorative with empty alt text, so a client that blocks images loses nothing.
 */
function emailShell(input: {
  preheader: string;
  planet: WelcomePlanet;
  headline: string;
  rows: string;
  unsubscribeUrl: string;
}) {
  const planetUrl = `${getWaitlistOrigin()}/landing/planets/${input.planet}.png`;
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:${BG};font-family:${FONT_STACK};">
    <span style="display:none;font-size:1px;color:${BG};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
      ${escapeHtml(input.preheader)}
    </span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BG};">
      <tr>
        <td align="center" style="padding:40px 20px;">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
            <tr>
              <td style="padding-bottom:26px;">
                <img src="${escapeHtml(planetUrl)}" alt="" width="44" height="44"
                     style="display:block;border:0;outline:none;width:44px;height:44px;" />
              </td>
            </tr>
            <tr>
              <td style="font-size:22px;line-height:1.35;color:${TEXT};font-weight:600;padding-bottom:18px;">
                ${escapeHtml(input.headline)}
              </td>
            </tr>
            ${input.rows}
            <tr>
              <td style="font-size:15px;line-height:1.65;color:${MUTED};padding-top:4px;padding-bottom:28px;">
                — Jason
              </td>
            </tr>
            <tr>
              <td style="font-size:12px;line-height:1.6;color:${FAINT};border-top:1px solid rgba(232,243,241,0.14);padding-top:22px;">
                ${WAITLIST_FOOTER}
                <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:${FAINT};text-decoration:underline;">Leave the waitlist</a>.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

const button = (href: string, label: string) => `<tr>
              <td style="padding-top:4px;padding-bottom:26px;">
                <a href="${escapeHtml(href)}"
                   style="display:inline-block;background-color:${ACCENT};color:${BG};font-weight:600;font-size:15px;text-decoration:none;padding:13px 26px;border-radius:10px;">
                  ${escapeHtml(label)}
                </a>
              </td>
            </tr>`;

/** The invite link printed in full, so it can be copied straight out of the email. */
const inviteLinkRow = (shareUrl: string) => `<tr>
              <td style="padding-bottom:24px;">
                <div style="font-size:11px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:${ACCENT};padding-bottom:8px;">
                  Your invite link
                </div>
                <a href="${escapeHtml(shareUrl)}" style="font-size:14px;color:${TEXT};word-break:break-all;text-decoration:underline;">${escapeHtml(shareUrl)}</a>
              </td>
            </tr>`;

/**
 * Sent the moment someone joins (and again when someone who left rejoins).
 *
 * It says three things: your place in line, that early access opens in waves and the
 * invite will come by email, and how to move up. `position` is null only when the line
 * could not be counted at join time; the email then leaves the number out rather than
 * guessing one.
 */
export function buildInterestListWelcomeEmail(input: {
  unsubscribeUrl: string;
  planet: WelcomePlanet;
  links?: EmailLinks;
  position?: number | null;
}) {
  const place = input.position ? `#${formatTicketNumber(input.position)}` : null;
  const subject = place ? `You're ${place} on the waitlist` : "You're on the waitlist";
  const headline = place ? `You're ${place} on the waitlist.` : "You're on the waitlist.";
  const opening =
    "Thanks for joining. We're opening early access in waves over the coming weeks, and you'll hear from me the moment yours opens.";
  const moveUp = `Want in sooner? When ${FRONT_WAVE_REFERRALS} friends join with your link, you move into the front wave — the first people through the door.`;

  const text = [
    headline,
    "",
    opening,
    "",
    ...(input.links
      ? [moveUp, "", `Your invite link: ${input.links.shareUrl}`, `Your pass: ${input.links.ticketUrl}`, ""]
      : []),
    "— Jason",
    "",
    "—",
    WAITLIST_FOOTER,
    `Leave the waitlist: ${input.unsubscribeUrl}`,
  ].join("\n");

  const rows = [
    paragraph(escapeHtml(opening)),
    ...(input.links
      ? [paragraph(escapeHtml(moveUp)), inviteLinkRow(input.links.shareUrl), button(input.links.ticketUrl, "See your pass")]
      : []),
  ].join("\n            ");

  const html = emailShell({
    preheader: "Your place in line, and how to move up.",
    planet: input.planet,
    headline,
    rows,
    unsubscribeUrl: input.unsubscribeUrl,
  });

  return { subject, html, text };
}

/** Sent to a referrer when their friends carry them into the front wave. */
export function buildFrontWaveEmail(input: {
  unsubscribeUrl: string;
  planet: WelcomePlanet;
  links: EmailLinks;
}) {
  const subject = "You're in the front wave";
  const headline = "You're in the front wave.";
  const body = `${FRONT_WAVE_REFERRALS} friends joined with your link, so you're now in the first group we let in. There's nothing else to do — your invite will arrive by email when the doors open.`;
  const thanks = "Thank you for spreading the word.";

  const text = [
    headline,
    "",
    body,
    "",
    thanks,
    "",
    `Your pass: ${input.links.ticketUrl}`,
    "",
    "— Jason",
    "",
    "—",
    WAITLIST_FOOTER,
    `Leave the waitlist: ${input.unsubscribeUrl}`,
  ].join("\n");

  const html = emailShell({
    preheader: "Your friends moved you up.",
    planet: input.planet,
    headline,
    rows: [paragraph(escapeHtml(body)), paragraph(escapeHtml(thanks)), button(input.links.ticketUrl, "See your pass")].join(
      "\n            "
    ),
    unsubscribeUrl: input.unsubscribeUrl,
  });

  return { subject, html, text };
}

/**
 * Who waitlist mail is from: `WAITLIST_FROM_EMAIL`, on the waitlist's own domain. A bare
 * address is given Jason's name; one that already carries a display name is left as is.
 *
 * Before a waitlist domain exists (no `WAITLIST_HOST`) the app's own sender still works,
 * so local development and the old list keep sending. Once there IS a waitlist domain, mail
 * never falls back to the app's sender: that would put the app's domain in the From line
 * of the one thing that must not show it. `lib/env.ts` requires the variable in that case.
 */
export function waitlistSender(): string | null {
  const configured =
    process.env.WAITLIST_FROM_EMAIL?.trim() ||
    (waitlistHost() ? "" : process.env.RESEND_FROM_EMAIL?.trim() ?? "");
  if (!configured) return null;
  return configured.includes("<") ? configured : `Jason <${configured}>`;
}

/** Where replies go. Never the app's contact inbox, whose address names the product. */
export function waitlistReplyTo(): string | undefined {
  return process.env.WAITLIST_REPLY_TO?.trim() || undefined;
}

/**
 * Never throws. Returns whether the message actually went out; the join ignores it, because
 * its signup row is durable either way and a Resend hiccup must not fail the submission.
 */
async function deliver(
  kind: "welcome" | "front-wave",
  email: string,
  unsubscribeUrl: string,
  message: { subject: string; html: string; text: string }
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = waitlistSender();
  if (!apiKey || !from) {
    console.warn(`[interest-list] Resend not configured — skipping ${kind} email`);
    return false;
  }

  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from,
      to: email,
      subject: message.subject,
      html: message.html,
      text: message.text,
      // Signed "— Jason", so a reply has to reach one: WAITLIST_REPLY_TO, or the From
      // address itself when none is configured.
      replyTo: waitlistReplyTo(),
      headers: {
        // One-click unsubscribe. Gmail and Yahoo require this on bulk mail, and without it
        // the only way out is the footer link — which recipients skip in favour of "spam",
        // and that is the signal that poisons a sending domain.
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    if (error) {
      console.error(`[interest-list] Resend rejected the ${kind} email`, error);
      await recordErrorEvent({
        source: ERROR_SOURCES.resendRejected,
        kind: `interest.${kind}`,
        message: error,
        context: { phase: "rejected", name: error.name },
      });
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[interest-list] Failed to send the ${kind} email`, err);
    // recordErrorEvent never throws, so deliver keeps its "never throws" contract.
    await recordErrorEvent({
      source: ERROR_SOURCES.resendRejected,
      kind: `interest.${kind}`,
      message: err,
      context: { phase: "threw" },
    });
    return false;
  }
}

/**
 * Best-effort. The signup itself is already durable in `interest_list_signups` by the time
 * this runs, so a Resend outage or a missing API key should never turn a successful signup
 * into a failed one — this only ever logs.
 */
export async function sendInterestListWelcomeEmail(
  email: string,
  unsubscribeUrl: string,
  planet: WelcomePlanet,
  links?: EmailLinks,
  position?: number | null
) {
  await deliver(
    "welcome",
    email,
    unsubscribeUrl,
    buildInterestListWelcomeEmail({ unsubscribeUrl, planet, links, position })
  );
}

/** Best-effort, like the welcome. Returns whether it sent. */
export async function sendFrontWaveEmail(
  email: string,
  unsubscribeUrl: string,
  planet: WelcomePlanet,
  links: EmailLinks
): Promise<boolean> {
  return deliver("front-wave", email, unsubscribeUrl, buildFrontWaveEmail({ unsubscribeUrl, planet, links }));
}
