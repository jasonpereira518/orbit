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
 * TWO PASSES IN ONE EMAIL: Apple Mail and iOS Mail get the printed pass, animated (see
 * `KINETIC_CSS`); every other client gets the still wallet pass. Inline styles and nested
 * tables carry the still one, for the same reason as the waitlist shell: clients strip
 * `<style>` and ignore CSS grid. Fraunces is named first for the clients that
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

/**
 * Which pass a client shows, and the motion Apple's clients play.
 *
 * The still pass is the default and needs no CSS at all. The printed pass ships hidden
 * inline (and `mso-hide` plus a conditional comment for Outlook's Word engine), and the
 * WebKit media query reveals it — Apple Mail and iOS Mail. Gmail also renders in WebKit on
 * the web, so its `u + .body` wrapper (Gmail puts a `<u>` before the body it rewrites into
 * a div) switches it straight back. Everything here is a progressive enhancement: a client
 * that drops the `<style>` block entirely shows the still pass.
 *
 * `prefers-reduced-motion` keeps the printed layout but cancels every animation, which
 * lands on the finished frame because each keyframe only animates FROM a hidden state.
 */
const KINETIC_CSS = `
@media screen and (-webkit-min-device-pixel-ratio:0) {
  .kinetic { display:block !important; max-height:none !important; overflow:visible !important; }
  .still { display:none !important; }
  .k-rise { animation:k-rise .8s cubic-bezier(.2,.8,.2,1) both; }
  .k-d1 { animation-delay:.15s; }
  .k-d2 { animation-delay:.35s; }
  .k-planet img { animation:k-launch 1.6s .2s cubic-bezier(.15,.85,.25,1) both; }
  .k-slot { animation:k-fade .5s 1.3s both; }
  .k-paper { animation:k-print 1.9s steps(19) 1.6s both; }
  .k-stamp { animation:k-stamp .45s 3.6s cubic-bezier(.3,1.6,.5,1) both; }
  .k-thump { animation:k-thump .3s 3.75s both; }
  .k-late { animation:k-rise .8s 4s cubic-bezier(.2,.8,.2,1) both; }
  .k-shine { position:relative; overflow:hidden; }
  .k-shine:after { content:""; position:absolute; top:0; bottom:0; left:0; width:40%;
    background:linear-gradient(100deg, rgba(255,255,255,0), rgba(255,255,255,.55), rgba(255,255,255,0));
    transform:translateX(-150%); animation:k-shine 2.8s 4.2s ease-in-out infinite; }
}
u + .body .kinetic, div > u + .body .kinetic { display:none !important; }
u + .body .still, div > u + .body .still { display:block !important; }
@media (prefers-reduced-motion: reduce) {
  .k-rise, .k-planet img, .k-slot, .k-paper, .k-stamp, .k-thump, .k-late, .k-shine:after { animation:none !important; }
}
@keyframes k-rise { from { opacity:0; transform:translateY(24px); } }
@keyframes k-fade { from { opacity:0; } }
@keyframes k-launch { from { opacity:0; transform:translateY(320px) scale(.6); } }
@keyframes k-print { from { transform:translateY(-100%); } }
@keyframes k-stamp { from { opacity:0; transform:rotate(-12deg) scale(2.4); } }
@keyframes k-thump { 30% { transform:translateY(3px); } }
@keyframes k-shine { to { transform:translateX(350%); } }
`;

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

  const fields = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                    ${field("Passenger", e(input.email))}
                    ${field("Class", "Orbit · full access", ACCENT)}
                        </tr>
                        <tr>
                    ${field("Invited by", SIGNATURE)}
                    ${boardBy ? field("Board by", e(boardBy)) : field("Gate", "Sign in")}
                        </tr>
                      </table>`;
  const cta = (extraClass: string) => `<a href="${e(input.url)}" class="${extraClass}"
                         style="display:block;text-align:center;background-color:${ACCENT};color:${BG};font-weight:600;font-size:15px;text-decoration:none;padding:14px 0;border-radius:10px;">
                        ${e(buttonLabel)}
                      </a>`;

  // Every client but Apple's: the still wallet pass (the planet sits inside the card).
  const stillPass = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
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
                      ${fields}
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:4px 22px 22px;">
                      ${cta("")}
                    </td>
                  </tr>
                </table>`;

  // Apple Mail and iOS Mail: the planet launches, a slot opens, the pass prints out of it
  // and a CLEARED stamp lands. Every animation runs FROM a hidden state to the element's
  // own styles, so a client that shows this block without animating it still gets a
  // complete, stamped pass — the resting frame is the design.
  const printedPass = `<div class="k-planet" style="text-align:center;padding:4px 0 18px;">
                  <img src="${e(planetUrl)}" alt="" width="104" height="104" style="display:inline-block;border:0;outline:none;width:104px;height:104px;" />
                </div>
                <div class="k-thump">
                  <div class="k-slot" style="height:14px;border-radius:7px;background-color:#000000;border:1px solid ${PASS_BORDER};position:relative;z-index:2;"></div>
                  <div style="overflow:hidden;margin-top:-8px;padding:0 10px 6px;">
                    <div class="k-paper" style="position:relative;background-color:${PASS_BG};border:1px solid ${PASS_BORDER};border-top:0;border-radius:0 0 16px 16px;padding:24px 22px 22px;">
                      <div class="k-stamp" style="position:absolute;right:18px;top:18px;border:3px solid ${ACCENT};color:${ACCENT};font-family:Menlo, 'Courier New', monospace;font-size:14px;font-weight:600;letter-spacing:0.14em;padding:5px 9px;border-radius:6px;transform:rotate(-12deg);">CLEARED</div>
                      ${label("Orbit · boarding pass")}
                      <div style="font-family:'Fraunces', Georgia, serif;font-size:24px;line-height:1.3;color:${TEXT};padding:2px 96px 16px 0;">You're cleared to board</div>
                      <div style="border-top:1px dashed ${PASS_BORDER};padding-top:18px;">
                        ${fields}
                      </div>
                      ${cta("k-shine")}
                    </div>
                  </div>
                </div>`;

  const html = `<!doctype html>
<html>
  <head>
    <meta name="color-scheme" content="dark" />
    <meta name="supported-color-schemes" content="dark" />
    <style>${KINETIC_CSS}</style>
  </head>
  <body class="body" style="margin:0;padding:0;background-color:${BG};font-family:${FONT_STACK};">
    <span style="display:none;font-size:1px;color:${BG};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
      ${e(`${lead} One seat on Orbit, everything included.`)}
    </span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="k-sky" style="background-color:${BG};">
      <tr>
        <td align="center" style="padding:36px 20px 40px;">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
            <tr>
              <td class="k-rise" style="padding-bottom:26px;">
                <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                  <td style="padding-right:9px;vertical-align:middle;">
                    <img src="${e(logoUrl)}" alt="" width="24" height="24" style="display:block;border:0;outline:none;width:24px;height:24px;" />
                  </td>
                  <td style="vertical-align:middle;font-family:'Fraunces', Georgia, serif;font-size:19px;color:${TEXT};">Orbit</td>
                </tr></table>
              </td>
            </tr>
            <tr>
              <td class="k-rise k-d1" style="font-family:'Fraunces', Georgia, serif;font-size:24px;line-height:1.3;color:${TEXT};padding-bottom:12px;">${e(lead)}</td>
            </tr>
            <tr>
              <td class="k-rise k-d2" style="font-size:15px;line-height:1.65;color:${MUTED};padding-bottom:24px;">${e(opening)}</td>
            </tr>
            <tr>
              <td>
                <!--[if !mso]><!-->
                <div class="kinetic" style="display:none;max-height:0;overflow:hidden;mso-hide:all;">
                ${printedPass}
                </div>
                <!--<![endif]-->
                <div class="still">
                ${stillPass}
                </div>
              </td>
            </tr>
            <tr>
              <td class="k-late" style="font-size:15px;line-height:1.65;color:${MUTED};padding-top:24px;padding-bottom:24px;">— ${SIGNATURE}</td>
            </tr>
            <tr>
              <td class="k-late" style="font-size:12px;line-height:1.6;color:${FAINT};border-top:1px solid rgba(232,243,241,0.14);padding-top:18px;">
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
