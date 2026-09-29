import { ACCENT, BG, FAINT, FONT_STACK, MUTED, RULE, SERIF_STACK, TEXT, escapeHtml } from "@/lib/interest-list-email";
import { KIND_LABELS, type RecommendationKind } from "@/lib/radar/types";

/**
 * Radar's Monday email, as markup: the week's top people, each with the one line of why and
 * a link straight to their card, and how many drafts are waiting.
 *
 * Branded, like the site invitation (`site-invite-email.ts`), because it goes to someone
 * who uses the product, from the app's sender. It borrows the waitlist's night palette and
 * the same rules: tables and inline styles only (clients strip `<style>`), every string
 * escaped, no image the message depends on. Every link is to the app itself; no third-party
 * URL appears, not even a headline's source, because the card has it. Names stay out of
 * the subject line, which a lock screen shows to anyone nearby.
 */

export type DigestPerson = {
  id: string;
  name: string;
  kind: RecommendationKind;
  company: string | null;
  /** The AI note's line when it is current, else the card's lead reason. */
  line: string;
  hasDraft: boolean;
};

export type DigestContent = {
  people: DigestPerson[];
  /** Everyone worth a message this week, not just the ones shown. */
  total: number;
  drafts: number;
};

const LINE_MAX = 180;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export function radarDigestSubject(content: Pick<DigestContent, "total" | "drafts">): string {
  const people = `${plural(content.total, "person", "people")} worth a message this week`;
  return content.drafts > 0 ? `${plural(content.drafts, "draft", "drafts")} ready · ${people}` : people;
}

export function buildRadarDigestEmail(
  content: DigestContent,
  links: { appUrl: string; unsubscribeUrl: string }
): { subject: string; html: string; text: string } {
  const subject = radarDigestSubject(content);
  const radarUrl = `${links.appUrl}/radar`;
  const cardUrl = (id: string) => `${radarUrl}?focus=${encodeURIComponent(id)}`;
  const settingsUrl = `${links.appUrl}/settings#settings-notifications`;
  const more = content.total - content.people.length;

  const summary = [
    plural(content.total, "person", "people") + " worth a message",
    content.drafts > 0 ? `${plural(content.drafts, "draft", "drafts")} ready to review` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const text = [
    "This week on Radar",
    summary,
    "",
    ...content.people.flatMap((p) => [
      `${p.name} — ${KIND_LABELS[p.kind]}${p.company ? ` · ${p.company}` : ""}${p.hasDraft ? " · draft ready" : ""}`,
      `  ${clip(p.line, LINE_MAX)}`,
      `  ${cardUrl(p.id)}`,
      "",
    ]),
    more > 0 ? `And ${plural(more, "other", "others")}: ${radarUrl}` : `Open Radar: ${radarUrl}`,
    "",
    "—",
    "You’re getting this because Radar’s Monday email is on.",
    `Turn it off: ${links.unsubscribeUrl}`,
    `Or change it in Settings: ${settingsUrl}`,
  ].join("\n");

  const rows = content.people
    .map((p) => {
      const meta = [KIND_LABELS[p.kind], p.company].filter(Boolean).map((v) => escapeHtml(String(v))).join(" · ");
      const draft = p.hasDraft
        ? ` <span style="color:${ACCENT};">· draft ready</span>`
        : "";
      return `<tr>
              <td style="padding:14px 0;border-top:1px solid ${RULE};">
                <a href="${escapeHtml(cardUrl(p.id))}" style="font-size:16px;font-weight:600;color:${TEXT};text-decoration:none;">${escapeHtml(p.name)}</a>
                <div style="font-size:13px;line-height:1.5;color:${FAINT};padding-top:2px;">${meta}${draft}</div>
                <div style="font-size:15px;line-height:1.55;color:${MUTED};padding-top:6px;">${escapeHtml(clip(p.line, LINE_MAX))}</div>
              </td>
            </tr>`;
    })
    .join("\n            ");

  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escapeHtml(subject)}</title></head>
  <body style="margin:0;padding:0;background-color:${BG};font-family:${FONT_STACK};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BG};">
      <tr>
        <td align="center" style="padding:36px 20px;">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
            <tr><td style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:${FAINT};padding-bottom:10px;">Orbit · Radar</td></tr>
            <tr><td style="font-family:${SERIF_STACK};font-size:26px;line-height:1.25;color:${TEXT};padding-bottom:6px;">This week on Radar</td></tr>
            <tr><td style="font-size:15px;line-height:1.5;color:${MUTED};padding-bottom:18px;">${escapeHtml(summary)}</td></tr>
            ${rows}
            <tr>
              <td style="padding:22px 0 8px;border-top:1px solid ${RULE};">
                <a href="${escapeHtml(radarUrl)}" style="display:inline-block;font-size:15px;font-weight:600;color:${BG};background:${ACCENT};border-radius:10px;padding:12px 22px;text-decoration:none;">${more > 0 ? `Open Radar · ${escapeHtml(plural(more, "other", "others"))}` : "Open Radar"}</a>
              </td>
            </tr>
            <tr>
              <td style="font-size:12px;line-height:1.6;color:${FAINT};padding-top:28px;">
                You’re getting this because Radar’s Monday email is on.
                <a href="${escapeHtml(links.unsubscribeUrl)}" style="color:${FAINT};">Turn it off</a>
                or <a href="${escapeHtml(settingsUrl)}" style="color:${FAINT};">change it in Settings</a>.
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
