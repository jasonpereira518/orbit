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

/**
 * The eight planets in `public/landing/planets/`, ordered by distance from the sun.
 * Successive signups get successive planets, so the list walks outward from Mercury and
 * wraps back round after Neptune.
 *
 * `sun.png` sits in that folder too and is deliberately absent: it is not a planet.
 */
export const WELCOME_PLANETS = [
  "mercury",
  "venus",
  "earth",
  "mars",
  "jupiter",
  "saturn",
  "uranus",
  "neptune",
] as const;

export type WelcomePlanet = (typeof WELCOME_PLANETS)[number];

/**
 * Maps a 1-based signup number onto the planet that signup receives: the 1st gets Mercury,
 * the 8th Neptune, the 9th Mercury again.
 *
 * Defensive about its input because the caller derives it from a COUNT that could in
 * principle come back 0 or non-finite — a negative index would otherwise read off the end
 * of the array and hand `undefined` to the template.
 */
export function planetForSignupNumber(signupNumber: number): WelcomePlanet {
  const n = Number.isFinite(signupNumber) ? Math.floor(signupNumber) : 1;
  return WELCOME_PLANETS[Math.max(0, n - 1) % WELCOME_PLANETS.length];
}

/**
 * Narrows the stored `welcome_planet` text back to the union. Rows written before that
 * column existed hold null, so the fallback is not theoretical — and an unrecognised value
 * must not reach the template, where it would build a 404 image URL.
 */
export function asWelcomePlanet(value: string | null | undefined): WelcomePlanet {
  return (WELCOME_PLANETS as readonly string[]).includes(value ?? "")
    ? (value as WelcomePlanet)
    : WELCOME_PLANETS[0];
}

const BG = "#05070f";
const TEXT = "#e8f3f1";
const MUTED = "#9aada8";
const FAINT = "#6d807c";
const ACCENT = "#f2c14e";
/** The drift/warning tone the landing page and forms already use for at-risk states. */
const WARN = "#e8a84e";
const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

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
export function buildInterestListWelcomeEmail(input: {
  unsubscribeUrl: string;
  /** Which planet this send gets. See `planetForSignupNumber`. */
  planet: WelcomePlanet;
}) {
  const appUrl = getAppBaseUrl();
  const signUpUrl = `${appUrl}/sign-up`;
  const logoUrl = `${appUrl}/orbit-logo.png`;
  const planetUrl = `${appUrl}/landing/planets/${input.planet}.png`;
  const subject = "You're on the Orbit list";

  const text = [
    "You're on the list.",
    "",
    "This one's just the hello — the actual news will come later, and not often.",
    "",
    `Though there is one thing worth saying now: Orbit is already live. No waitlist to clear, no invite to wait for, free for your first ${FREE_CONTACT_LIMIT} contacts — and you don't have to connect LinkedIn or Gmail to try it. You can add a few people by hand first and see how it works.`,
    "",
    "If you're interviewing at the moment, that's when it earns its keep — it's built so the person who could refer you doesn't go cold while you're busy with everything else.",
    "",
    "    This week in your network",
    "     3  warm intros available",
    "    12  people drifting",
    "     2  follow-ups due",
    "",
    `Try it now: ${signUpUrl}`,
    "",
    "And if you're not signing up, I'd genuinely like to know what put you off — just hit reply. It comes straight to me.",
    "",
    "— Jason",
    "",
    `PS — everyone on this list gets a different planet, in order out from the sun. You got ${titleCase(input.planet)}.`,
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
              `Though there is one thing worth saying now: Orbit is <strong style="color:${TEXT};font-weight:600;">already live</strong>. No waitlist to clear, no invite to wait for, free for your first ${FREE_CONTACT_LIMIT} contacts — and you don't have to connect LinkedIn or Gmail to try it. You can add a few people by hand first and see how it works.`
            )}
            ${paragraph(
              "If you're interviewing at the moment, that's when it earns its keep — it's built so the person who could refer you doesn't go cold while you're busy with everything else."
            )}
            <!-- The product at a glance, drawn rather than screenshotted: table cells and
                 background colours render with images blocked, and stay crisp on any DPI.
                 Deliberately carries no invented person — the numbers alone say what Orbit
                 watches, and a fabricated name in a real inbox invites the reader to work
                 out whether it is someone they know. -->
            <tr>
              <td style="padding-top:6px;padding-bottom:28px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                       style="background-color:#0a0f1c;border:1px solid rgba(232,243,241,0.12);border-radius:14px;">
                  <tr>
                    <td style="padding:18px 20px;">
                      <div style="font-size:11px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:${ACCENT};padding-bottom:14px;">
                        This week in your network
                      </div>
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                        ${[
                          { n: "3", label: "warm intros available", color: ACCENT },
                          { n: "12", label: "people drifting", color: WARN },
                          { n: "2", label: "follow-ups due", color: TEXT },
                        ]
                          .map(
                            (row) => `<tr>
                          <td width="38" align="right" valign="middle"
                              style="font-size:19px;font-weight:600;color:${row.color};padding:5px 12px 5px 0;">${row.n}</td>
                          <td valign="middle" style="font-size:14px;color:${MUTED};padding:5px 0;">${row.label}</td>
                        </tr>`
                          )
                          .join("\n                        ")}
                      </table>
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
            <!-- Plain text, deliberately not a second button: the reply is the point, and a
                 rival CTA would compete with "Try it now" above. Reply-To is a real inbox. -->
            ${paragraph(
              "And if you're not signing up, I'd genuinely like to know what put you off — just hit reply. It comes straight to me."
            )}
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
                      <img src="${planetUrl}" alt="" width="38" height="38"
                           style="display:block;border:0;outline:none;width:38px;height:38px;opacity:0.8;" />
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <!-- The postscript names the planet above, which is the only thing in the mail
                 that explains it. It reads as a throwaway; it is also the reason the planet
                 is stored on the row rather than recomputed, so this stays true on a resend. -->
            <tr>
              <td style="font-size:13px;line-height:1.6;color:${FAINT};padding-bottom:28px;">
                PS — everyone on this list gets a different planet, in order out from the sun.
                You got <span style="color:${MUTED};">${titleCase(input.planet)}</span>.
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
 * The day-3 follow-up, sent only to someone who joined the list and did NOT go on to create
 * an account (see `sweepInterestListFollowUps`).
 *
 * ONE TIP, NO PITCH — and that constraint is load-bearing. This is the second unsolicited
 * mail in three days from a product they declined once; a second sales push is how a list
 * this small teaches people to mark it as spam. So the advice has to stand on its own even
 * for a reader who never signs up, and the only link is a quiet text one, never a button.
 *
 * The tip attacks the same objection the welcome mail does — that setting this up is a
 * project — from the other side: not "it's easy" but "you're allowed to start tiny".
 */
export function buildInterestListFollowUpEmail(input: {
  unsubscribeUrl: string;
  planet: WelcomePlanet;
}) {
  const appUrl = getAppBaseUrl();
  const signUpUrl = `${appUrl}/sign-up`;
  const logoUrl = `${appUrl}/orbit-logo.png`;
  const planetUrl = `${appUrl}/landing/planets/${input.planet}.png`;
  const subject = "One tip: start with five people";

  const text = [
    "A few days ago you joined Orbit's interest list. No pitch in this one — just the thing I'd tell anyone starting out.",
    "",
    "Start with five people, not five hundred.",
    "",
    "The instinct is to import everything and sort it out later. That usually ends in a list nobody opens. Pick the five people who could actually change your next month — the ones who would take your call — and put only them in.",
    "",
    "Five is small enough that keeping it current costs nothing, and big enough that you notice when one of them goes quiet. If it earns its place, the rest can follow.",
    "",
    "That works whether or not you use Orbit. A note in your phone is a fine start.",
    "",
    `If you'd rather it nagged you for you: ${signUpUrl}`,
    "",
    "— Jason",
    "",
    "—",
    "You're getting this because you joined Orbit's interest list. This is the last one unless there's real news.",
    `Unsubscribe any time: ${input.unsubscribeUrl}`,
  ].join("\n");

  const paragraph = (content: string) =>
    `<tr><td style="font-size:15px;line-height:1.65;color:${MUTED};padding-bottom:18px;">${content}</td></tr>`;

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:${BG};font-family:${FONT_STACK};">
    <span style="display:none;font-size:1px;color:${BG};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
      The one thing I'd tell anyone starting out.
    </span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BG};">
      <tr>
        <td align="center" style="padding:40px 20px;">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
            <tr>
              <td style="padding-bottom:30px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
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
            ${paragraph(
              "A few days ago you joined Orbit's interest list. No pitch in this one — just the thing I'd tell anyone starting out."
            )}
            <tr>
              <td style="font-size:21px;line-height:1.35;color:${TEXT};font-weight:600;padding-bottom:18px;">
                Start with five people, not five hundred.
              </td>
            </tr>
            ${paragraph(
              "The instinct is to import everything and sort it out later. That usually ends in a list nobody opens. Pick the five people who could actually change your next month — the ones who would take your call — and put only them in."
            )}
            ${paragraph(
              `Five is small enough that keeping it current costs nothing, and big enough that you notice when one of them goes quiet. If it earns its place, the rest can follow.`
            )}
            ${paragraph(
              `That works whether or not you use Orbit — a note in your phone is a fine start. If you'd rather it nagged you for you, <a href="${signUpUrl}" style="color:${ACCENT};text-decoration:underline;">it's here</a>.`
            )}
            <tr>
              <td style="padding-top:8px;padding-bottom:26px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td valign="middle" style="font-size:15px;line-height:1.65;color:${MUTED};">
                      — Jason
                    </td>
                    <td align="right" valign="middle">
                      <img src="${planetUrl}" alt="" width="38" height="38"
                           style="display:block;border:0;outline:none;width:38px;height:38px;opacity:0.8;" />
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="font-size:12px;line-height:1.6;color:${FAINT};border-top:1px solid rgba(232,243,241,0.14);padding-top:22px;">
                You're getting this because you joined Orbit's interest list. This is the last
                one unless there's real news.
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
 * Never throws. Returns whether the message actually went out, which the day-3 sweep needs
 * in order to release a row it has already claimed — the welcome path ignores it, because
 * its signup row is durable either way and a Resend hiccup must not fail the submission.
 */
async function deliver(
  kind: "welcome" | "follow-up",
  email: string,
  unsubscribeUrl: string,
  message: { subject: string; html: string; text: string }
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = fromAddress();
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
      console.error(`[interest-list] Resend rejected the ${kind} email`, error);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[interest-list] Failed to send the ${kind} email`, err);
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
  planet: WelcomePlanet
) {
  await deliver(
    "welcome",
    email,
    unsubscribeUrl,
    buildInterestListWelcomeEmail({ unsubscribeUrl, planet })
  );
}

/** Returns whether it sent, so the sweep can un-claim the row if it did not. */
export async function sendInterestListFollowUpEmail(
  email: string,
  unsubscribeUrl: string,
  planet: WelcomePlanet
): Promise<boolean> {
  return deliver(
    "follow-up",
    email,
    unsubscribeUrl,
    buildInterestListFollowUpEmail({ unsubscribeUrl, planet })
  );
}
