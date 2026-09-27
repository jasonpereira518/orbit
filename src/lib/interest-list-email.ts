import { randomBytes } from "node:crypto";
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import { getWaitlistOrigin } from "@/lib/app-url";
import { formatTicketNumber, FRONT_WAVE_REFERRALS } from "@/lib/interest-list";
import { waitlistHost } from "@/lib/waitlist-host";
import { planetLabel, type WelcomePlanet } from "@/lib/welcome-planets";

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

/**
 * The dark palette. No waitlist email uses it any more; the admin invitation
 * (`site-invite-email.ts`) still builds its boarding pass from these.
 */
export const BG = "#05070f";
export const TEXT = "#e8f3f1";
export const MUTED = "#9aada8";
export const FAINT = "#6d807c";
export const ACCENT = "#f2c14e";
export const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** The paper letter every waitlist email is written on. */
export const PAPER = "#f6f4ee";
export const INK = "#1d2320";
export const INK_MUTED = "#5d6661";
export const INK_FAINT = "#8a918c";
export const RULE = "#e2e0d8";
export const LINK = "#0f3d3e";
export const SERIF_STACK = "'Fraunces', Georgia, 'Times New Roman', serif";

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The footer every waitlist email ends with. */
export const WAITLIST_FOOTER = "You're getting this because you joined the waitlist.";

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const inWords = (n: number) => NUMBER_WORDS[n] ?? String(n);
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** A body paragraph. `content` is HTML the caller has already escaped. */
export const paperParagraph = (content: string) =>
  `<tr><td style="font-size:15px;line-height:1.65;color:${INK_MUTED};padding-bottom:16px;">${content}</td></tr>`;

/** The one link in a waitlist email: underlined teal text, not a button. */
const textLink = (href: string, label: string) =>
  `<a href="${escapeHtml(href)}" style="color:${LINK};text-decoration:underline;font-weight:600;">${escapeHtml(label)}</a>`;

/**
 * The paper letter every waitlist email shares: an eyebrow line with the planet, a serif
 * headline, the body rows, the sign-off and the leave link.
 *
 * UNBRANDED ON PURPOSE. The waitlist does not name the product, show its logo, link to its
 * domain or describe what it does (see `lib/waitlist-host.ts`), and an email is the easiest
 * thing in the world to forward, so these carry no name but Jason's, no image but the
 * planet, and no link that is not on the waitlist's own domain.
 *
 * WRITTEN TO REACH THE INBOX. A light letter with one text link, no button, no printed
 * referral URL and a plain-text twin reads as correspondence rather than a campaign, which
 * is how the filters that were junking the old dark card score it. `color-scheme: light`
 * asks clients not to invert it; the ones that do anyway still get readable ink on paper.
 *
 * Inline styles and a table shell rather than a stylesheet: most email clients strip
 * `<style>` blocks. The planet is decorative with empty alt text, so a client that blocks
 * images loses nothing.
 */
export function paperShell(input: {
  preheader?: string;
  /** Small caps line above the headline, beside the planet. Escaped here. */
  eyebrow?: string;
  planet?: WelcomePlanet;
  /** Serif headline. Escaped here. Omitted, the rows start straight away. */
  headline?: string;
  rows: string;
  unsubscribeUrl: string;
}) {
  const planetImg = input.planet
    ? `<img src="${escapeHtml(`${getWaitlistOrigin()}/landing/planets/${input.planet}.png`)}" alt="" width="28" height="28"
                           style="display:block;border:0;outline:none;width:28px;height:28px;" />`
    : "";
  const eyebrow =
    input.eyebrow || planetImg
      ? `<tr>
              <td style="padding-bottom:18px;">
                <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                  ${planetImg ? `<td style="padding-right:10px;vertical-align:middle;">${planetImg}</td>` : ""}
                  ${
                    input.eyebrow
                      ? `<td style="vertical-align:middle;font-size:12px;letter-spacing:0.14em;text-transform:uppercase;color:${INK_FAINT};">${escapeHtml(input.eyebrow)}</td>`
                      : ""
                  }
                </tr></table>
              </td>
            </tr>`
      : "";
  const headline = input.headline
    ? `<tr>
              <td style="font-family:${SERIF_STACK};font-size:25px;line-height:1.25;color:${INK};padding-bottom:16px;">
                ${escapeHtml(input.headline)}
              </td>
            </tr>`
    : "";
  const preheader = input.preheader
    ? `<span style="display:none;font-size:1px;color:${PAPER};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
      ${escapeHtml(input.preheader)}
    </span>`
    : "";

  return `<!doctype html>
<html>
  <head>
    <meta name="color-scheme" content="light only" />
    <meta name="supported-color-schemes" content="light" />
  </head>
  <body style="margin:0;padding:0;background-color:${PAPER};font-family:${FONT_STACK};color:${INK};">
    ${preheader}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${PAPER};">
      <tr>
        <td align="center" style="padding:44px 20px;">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
            ${eyebrow}
            ${headline}
            ${input.rows}
            <tr>
              <td style="font-size:15px;line-height:1.65;color:${INK};padding-top:4px;padding-bottom:28px;">
                — Jason
              </td>
            </tr>
            <tr>
              <td style="font-size:12px;line-height:1.6;color:${INK_FAINT};border-top:1px solid ${RULE};padding-top:18px;">
                ${WAITLIST_FOOTER}
                <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:${INK_FAINT};text-decoration:underline;">Leave the waitlist</a>.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * Sent the moment someone joins (and again when someone who left rejoins).
 *
 * It says three things: your place in line, that spots open a few at a time and the
 * invite will come by email, and how to move up. `position` is null only when the line
 * could not be counted at join time; the email then leaves the number out rather than
 * guessing one. The referral link itself is not in the email: the pass page shows it with a
 * copy button, and a printed `?ref=` URL was one of the things filters held against it.
 */
export function buildInterestListWelcomeEmail(input: {
  unsubscribeUrl: string;
  planet: WelcomePlanet;
  links?: EmailLinks;
  position?: number | null;
}) {
  const place = input.position ? formatTicketNumber(input.position) : null;
  const subject = "You're on the list";
  const headline = "Thanks for joining.";
  const opening = `${place ? `You're #${place} in line. ` : ""}I'm letting people in a few at a time, in the order they joined. When your spot opens, I'll write to you here.`;
  const moveUp = `${capitalize(inWords(FRONT_WAVE_REFERRALS))} friends joining from your pass moves you into the front wave, the first group through the door.`;

  const text = [
    headline,
    "",
    opening,
    "",
    ...(input.links ? [moveUp, "", `Open your pass: ${input.links.ticketUrl}`, ""] : []),
    "— Jason",
    "",
    "—",
    WAITLIST_FOOTER,
    `Leave the waitlist: ${input.unsubscribeUrl}`,
  ].join("\n");

  const rows = [
    paperParagraph(escapeHtml(opening)),
    ...(input.links ? [paperParagraph(`${escapeHtml(moveUp)} ${textLink(input.links.ticketUrl, "Open your pass")}`)] : []),
  ].join("\n            ");

  const html = paperShell({
    preheader: "A quick note on what happens next.",
    eyebrow: `${place ? `No. ${place}` : "On the waitlist"} · ${planetLabel(input.planet)}`,
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
  const subject = "You moved to the front";
  const headline = "You're in the front wave.";
  const body = `${capitalize(inWords(FRONT_WAVE_REFERRALS))} friends joined from your pass, so you'll be in the first group through the door. There's nothing else to do; your invite will come by email.`;
  const thanks = "Thank you for passing it on.";

  const text = [
    headline,
    "",
    body,
    "",
    thanks,
    "",
    `Open your pass: ${input.links.ticketUrl}`,
    "",
    "— Jason",
    "",
    "—",
    WAITLIST_FOOTER,
    `Leave the waitlist: ${input.unsubscribeUrl}`,
  ].join("\n");

  const html = paperShell({
    preheader: thanks,
    eyebrow: `Front wave · ${planetLabel(input.planet)}`,
    planet: input.planet,
    headline,
    rows: [
      paperParagraph(escapeHtml(body)),
      paperParagraph(`${escapeHtml(thanks)} ${textLink(input.links.ticketUrl, "Open your pass")}`),
    ].join("\n            "),
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
    // Loaded on send, inside the same try: the SDK stays off cold starts that send nothing.
    const { Resend } = await import("resend");
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
