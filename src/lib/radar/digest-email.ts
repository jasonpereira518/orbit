import { ACCENT, BG, FAINT, FONT_STACK, MUTED, RULE, SERIF_STACK, TEXT, escapeHtml } from "@/lib/interest-list-email";
import { KIND_LABELS, LANE_OF_KIND, LANE_TITLES, RADAR_LANES, type RecommendationKind } from "@/lib/radar/types";

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
  /** On the Today strip: shown first, under its own heading. */
  today?: boolean;
};

/** The Opportunities lane's web finds, counted; the next event named. No third-party link. */
export type DigestFinds = { events: number; people: number; programs: number; nextEvent: { title: string; startsAt: string } | null };

export type DigestContent = {
  people: DigestPerson[];
  /** Everyone worth a message this week, not just the ones shown. */
  total: number;
  drafts: number;
  finds?: DigestFinds | null;
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
    "Your week on Radar",
    summary,
    "",
    ...digestSections(content.people).flatMap((sec) => [
      sec.title.toUpperCase(),
      ...sec.people.flatMap((p) => [
        `${p.name} — ${KIND_LABELS[p.kind]}${p.company ? ` · ${p.company}` : ""}${p.hasDraft ? " · draft ready" : ""}`,
        `  ${clip(p.line, LINE_MAX)}`,
        `  ${cardUrl(p.id)}`,
        "",
      ]),
    ]),
    ...(findsSummary(content.finds) ? [LANE_TITLES.opportunities.toUpperCase(), findsSummary(content.finds)!, ""] : []),
    more > 0 ? `And ${plural(more, "other", "others")}: ${radarUrl}` : `Open Radar: ${radarUrl}`,
    "",
    "—",
    "You’re getting this because Radar’s Monday email is on.",
    `Turn it off: ${links.unsubscribeUrl}`,
    `Or change it in Settings: ${settingsUrl}`,
  ].join("\n");

  const sections = digestSections(content.people);
  const findsLine = findsSummary(content.finds);
  const rows = [
    ...sections.map((sec) => `${sectionHeading(sec.title)}\n            ${sec.people.map((p) => personRow(p, cardUrl(p.id))).join("\n            ")}`),
    findsLine ? `${sectionHeading(LANE_TITLES.opportunities)}\n            ${findsRow(findsLine)}` : "",
  ]
    .filter(Boolean)
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
            <tr><td style="font-family:${SERIF_STACK};font-size:26px;line-height:1.25;color:${TEXT};padding-bottom:6px;">Your week on Radar</td></tr>
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

/** Today first, then each lane in order; empty groups are left out. */
export function digestSections(people: readonly DigestPerson[]): { title: string; people: DigestPerson[] }[] {
  const today = people.filter((p) => p.today);
  const rest = people.filter((p) => !p.today);
  return [
    { title: "Today", people: today },
    ...RADAR_LANES.map((lane) => ({ title: LANE_TITLES[lane], people: rest.filter((p) => LANE_OF_KIND[p.kind] === lane) })),
  ].filter((sec) => sec.people.length > 0);
}

/** "Austin Climate Meetup · Fri 20 Nov · + 1 person to meet, 1 program": null when nothing was found. */
export function findsSummary(finds: DigestFinds | null | undefined): string | null {
  if (!finds) return null;
  const others = [
    finds.events > (finds.nextEvent ? 1 : 0) ? plural(finds.events - (finds.nextEvent ? 1 : 0), "more event", "more events") : null,
    finds.people > 0 ? plural(finds.people, "person to meet", "people to meet") : null,
    finds.programs > 0 ? plural(finds.programs, "program", "programs") : null,
  ].filter(Boolean);
  const event = finds.nextEvent
    ? `${clip(finds.nextEvent.title, 80)} · ${new Date(finds.nextEvent.startsAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}`
    : null;
  if (!event && others.length === 0) return null;
  return [event, others.length ? `${event ? "+ " : ""}${others.join(", ")}` : null].filter(Boolean).join(" · ");
}

function sectionHeading(title: string) {
  return `<tr><td style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:${ACCENT};padding:16px 0 2px;">${escapeHtml(title)}</td></tr>`;
}

function personRow(p: DigestPerson, href: string) {
  const meta = [KIND_LABELS[p.kind], p.company].filter(Boolean).map((v) => escapeHtml(String(v))).join(" · ");
  const draft = p.hasDraft ? ` <span style="color:${ACCENT};">· draft ready</span>` : "";
  return `<tr>
              <td style="padding:14px 0;border-top:1px solid ${RULE};">
                <a href="${escapeHtml(href)}" style="font-size:16px;font-weight:600;color:${TEXT};text-decoration:none;">${escapeHtml(p.name)}</a>
                <div style="font-size:13px;line-height:1.5;color:${FAINT};padding-top:2px;">${meta}${draft}</div>
                <div style="font-size:15px;line-height:1.55;color:${MUTED};padding-top:6px;">${escapeHtml(clip(p.line, LINE_MAX))}</div>
              </td>
            </tr>`;
}

function findsRow(line: string) {
  return `<tr><td style="padding:14px 0;border-top:1px solid ${RULE};font-size:15px;line-height:1.55;color:${MUTED};">${escapeHtml(line)}</td></tr>`;
}

const COUNT_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six"];

/**
 * The same-day email (`moments.ts`): the Today items Radar is alerting about, at most one such
 * email a day. The subject only counts, because a lock screen shows it; names are inside.
 */
export function buildRadarMomentEmail(
  people: readonly Pick<DigestPerson, "id" | "name" | "kind" | "line" | "hasDraft">[],
  links: { appUrl: string; unsubscribeUrl: string }
): { subject: string; html: string; text: string } {
  const n = people.length;
  const subject = `${plural(n, "thing", "things")} on Radar won’t keep`;
  const heading = `${COUNT_WORDS[n] ?? n} ${n === 1 ? "thing won’t" : "things won’t"} keep today`;
  const radarUrl = `${links.appUrl}/radar`;
  const cardUrl = (id: string) => `${radarUrl}?focus=${encodeURIComponent(id)}`;
  const settingsUrl = `${links.appUrl}/radar`;
  const only = n === 1 ? people[0] : null;
  const button = only ? { href: cardUrl(only.id), label: only.hasDraft ? "Review the draft" : "Open it on Radar" } : { href: radarUrl, label: "Open Radar" };
  const rows = people.map((p) => personRow({ ...p, company: null }, cardUrl(p.id))).join("\n            ");

  const text = [
    heading,
    "",
    ...people.flatMap((p) => [`${p.name} — ${KIND_LABELS[p.kind]}${p.hasDraft ? " · draft ready" : ""}`, `  ${clip(p.line, LINE_MAX)}`, `  ${cardUrl(p.id)}`, ""]),
    "—",
    "You’re getting this because Radar’s same-day email is on. At most one a day.",
    `Turn it off: ${links.unsubscribeUrl}`,
  ].join("\n");

  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escapeHtml(subject)}</title></head>
  <body style="margin:0;padding:0;background-color:${BG};font-family:${FONT_STACK};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BG};">
      <tr>
        <td align="center" style="padding:36px 20px;">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
            <tr><td style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:${FAINT};padding-bottom:10px;">Orbit · Radar</td></tr>
            <tr><td style="font-family:${SERIF_STACK};font-size:26px;line-height:1.25;color:${TEXT};padding-bottom:18px;">${escapeHtml(heading)}</td></tr>
            ${rows}
            <tr>
              <td style="padding:22px 0 8px;border-top:1px solid ${RULE};">
                <a href="${escapeHtml(button.href)}" style="display:inline-block;font-size:15px;font-weight:600;color:${BG};background:${ACCENT};border-radius:10px;padding:12px 22px;text-decoration:none;">${escapeHtml(button.label)}</a>
              </td>
            </tr>
            <tr>
              <td style="font-size:12px;line-height:1.6;color:${FAINT};padding-top:28px;">
                You’re getting this because Radar’s same-day email is on. At most one a day.
                <a href="${escapeHtml(links.unsubscribeUrl)}" style="color:${FAINT};">Turn it off</a>
                or <a href="${escapeHtml(settingsUrl)}" style="color:${FAINT};">change it in Radar’s settings</a>.
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
