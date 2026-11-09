/**
 * Past meetings: a page at a time with search, and the passage search Chat uses.
 *
 * Read-only over `meeting_sessions` and `meeting_transcript_segments`, and split from the
 * `"use server"` wrappers the same way `capture-history.ts` is, so
 * `scripts/smoke-meetings-list.ts` can drive it against PGlite with no auth. Every query is
 * scoped to the user it is handed.
 *
 * Granola-synced notes are listed alongside, from the batches the sync saved (see
 * `listGranola`).
 *
 * Only finished meetings are listed (`analyzed` or `saved`). One still recording, or ended
 * but not yet summarized, is the resume banner's business, not history's.
 *
 * Search is `ILIKE` over the title, the summary, the guest names and the transcript. That is
 * a scan, bounded by one user's meetings — fine at this scale; a tsvector over the segment
 * text is the upgrade if it ever is not.
 */
import { and, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb, rowsOf } from "@/db";
import {
  calendarEvents,
  companies,
  contacts,
  interactions,
  meetingSessions,
  meetingTranscriptSegments,
  noteBatches,
  orgBrandColors,
  type MeetingSessionStatus,
} from "@/db/schema";
import { brandKey, CURATED_COMPANIES, type CuratedCompany } from "@/lib/brand-colors";
import { companyFromEmail } from "@/lib/guest-profiles";
import { toDomain } from "@/lib/org-brand-learn";
import { listSummary } from "@/lib/plain-text";
import { callFromSurface } from "@/lib/call-kind";

export const MEETINGS_PAGE = 20;
const LISTED: MeetingSessionStatus[] = ["analyzed", "saved"];
const MAX_QUERY_CHARS = 100;

/** Recorded in Orbit, or synced from Granola. */
export type MeetingSource = "orbit" | "granola";
export type MeetingSourceFilter = MeetingSource | "all";

export type MeetingListItem = {
  /** A meeting session's id, or for Granola the note batch's. */
  id: string;
  source: MeetingSource;
  title: string | null;
  /** ISO. */
  startedAt: string;
  durationMs: number;
  status: "analyzed" | "saved";
  attendees: string[];
  /** The digest's summary (or Granola's), as plain prose trimmed for a list. */
  summary: string | null;
  /** The calendar event's video call ("meet", "zoom", "teams", "webex"), when it was recorded from one. */
  call: string | null;
  /** Recorded from a shared tab or screen rather than the room's mic. */
  sharedScreen: boolean;
  /** Up to two companies the meeting involved, for their logos (`/api/logos/[domain]`). */
  companies: MeetingCompany[];
  noteBatchId: string | null;
  /** With a search: the first line of transcript that matched, and when it was said. */
  match: { startMs: number; excerpt: string } | null;
};

export type MeetingsPage = {
  items: MeetingListItem[];
  /** Opaque; hand it back for the next page. Null when there is nothing older. */
  nextCursor: string | null;
};

/** `started_at` as Postgres prints it (microseconds survive; a JS Date would round them), then the id. */
function decodeCursor(cursor: string | null | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  const bar = cursor.lastIndexOf("|");
  if (bar <= 0) return null;
  const at = cursor.slice(0, bar);
  const id = cursor.slice(bar + 1);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/.test(at)) return null;
  return { at, id };
}

/** A user's text as a LIKE pattern: wildcards are theirs to type, not to have interpreted. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, "\\$&")}%`;
}

/** A short window of `text` around the first occurrence of `needle` (case-insensitive). */
export function excerptAround(text: string, needle: string, radius = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0 || flat.length <= radius * 2) return flat.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + needle.length + radius);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

export async function listMeetingsFor(
  userId: string,
  opts: { q?: string | null; cursor?: string | null; limit?: number; source?: MeetingSourceFilter } = {}
): Promise<MeetingsPage> {
  const limit = Math.min(Math.max(opts.limit ?? MEETINGS_PAGE, 1), 50);
  const q = (opts.q ?? "").trim().slice(0, MAX_QUERY_CHARS);
  const after = decodeCursor(opts.cursor);
  const source = opts.source ?? "all";

  // One keyset over two tables: each side returns its own `limit + 1` older than the cursor,
  // and the merge keeps the newest `limit`. Anything past the cut on either side is older
  // than it, so the next page's cursor (the last row kept) loses nothing and repeats nothing.
  const [orbit, granola] = await Promise.all([
    source === "granola" ? [] : listRecorded(userId, q, after, limit),
    source === "orbit" ? [] : listGranola(userId, q, after, limit),
  ]);
  const merged = [...orbit, ...granola].sort(
    (a, b) => b.atMs - a.atMs || (a.atText < b.atText ? 1 : a.atText > b.atText ? -1 : 0) || (a.item.id < b.item.id ? 1 : -1)
  );
  const page = merged.slice(0, limit);
  const last = page[page.length - 1];
  await addCallsAndCompanies(userId, page);
  return {
    items: page.map((r) => r.item),
    nextCursor: merged.length > limit && last ? `${last.atText}|${last.item.id}` : null,
  };
}

/** `hints` are what `addCallsAndCompanies` looks up for the page that is kept. */
type Ranked = {
  atMs: number;
  atText: string;
  item: MeetingListItem;
  hints: { emails: string[]; contactIds: string[]; eventKey: string | null };
};

async function listRecorded(
  userId: string,
  q: string,
  after: { at: string; id: string } | null,
  limit: number
): Promise<Ranked[]> {
  const db = await getDb();
  const conditions: (SQL | undefined)[] = [
    eq(meetingSessions.userId, userId),
    inArray(meetingSessions.status, LISTED),
    after
      ? sql`(${meetingSessions.startedAt}, ${meetingSessions.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`
      : undefined,
  ];
  if (q) {
    const pattern = likePattern(q);
    conditions.push(sql`(
      ${meetingSessions.title} ILIKE ${pattern}
      OR ${meetingSessions.digest}->>'summary' ILIKE ${pattern}
      OR ${meetingSessions.attendees}::text ILIKE ${pattern}
      OR ${meetingSessions.userNotes} ILIKE ${pattern}
      OR EXISTS (
        SELECT 1 FROM ${meetingTranscriptSegments}
        WHERE ${meetingTranscriptSegments.sessionId} = ${meetingSessions.id}
          AND ${meetingTranscriptSegments.userId} = ${userId}
          AND ${meetingTranscriptSegments.text} ILIKE ${pattern}
      )
    )`);
  }

  const rows = await db
    .select({
      id: meetingSessions.id,
      title: meetingSessions.title,
      startedAt: meetingSessions.startedAt,
      startedAtText: sql<string>`${meetingSessions.startedAt}::text`,
      durationMs: meetingSessions.durationMs,
      status: meetingSessions.status,
      attendees: meetingSessions.attendees,
      summary: sql<string | null>`left(${meetingSessions.digest}->>'summary', 600)`,
      digestTitle: sql<string | null>`${meetingSessions.digest}->>'title'`,
      noteBatchId: meetingSessions.noteBatchId,
      captureSurface: meetingSessions.captureSurface,
      calendarEventKey: meetingSessions.calendarEventKey,
    })
    .from(meetingSessions)
    .where(and(...conditions))
    .orderBy(desc(meetingSessions.startedAt), desc(meetingSessions.id))
    .limit(limit + 1);

  // With a search, show WHY each row matched: the first transcript line that did.
  const matches = new Map<string, { startMs: number; excerpt: string }>();
  if (q && rows.length) {
    const hits = await db
      .selectDistinctOn([meetingTranscriptSegments.sessionId], {
        sessionId: meetingTranscriptSegments.sessionId,
        startMs: meetingTranscriptSegments.startMs,
        text: meetingTranscriptSegments.text,
      })
      .from(meetingTranscriptSegments)
      .where(
        and(
          eq(meetingTranscriptSegments.userId, userId),
          inArray(
            meetingTranscriptSegments.sessionId,
            rows.map((r) => r.id)
          ),
          sql`${meetingTranscriptSegments.text} ILIKE ${likePattern(q)}`
        )
      )
      .orderBy(meetingTranscriptSegments.sessionId, meetingTranscriptSegments.seq);
    for (const h of hits) matches.set(h.sessionId, { startMs: h.startMs, excerpt: excerptAround(h.text, q) });
  }

  return rows.map((r) => ({
    atMs: r.startedAt.getTime(),
    atText: r.startedAtText,
    item: {
      id: r.id,
      source: "orbit",
      title: r.title?.trim() || r.digestTitle?.trim() || null,
      startedAt: r.startedAt.toISOString(),
      durationMs: r.durationMs,
      status: r.status as "analyzed" | "saved",
      attendees: (r.attendees ?? []).map((a) => a.name).filter(Boolean),
      summary: listSummary(r.summary),
      // The shared window's app, when the recorder could tell; a calendar invite overrides it.
      call: callFromSurface(r.captureSurface),
      sharedScreen: Boolean(r.captureSurface),
      companies: [],
      noteBatchId: r.noteBatchId,
      match: matches.get(r.id) ?? null,
    },
    hints: {
      emails: (r.attendees ?? []).flatMap((a) => (a.email ? [a.email] : [])),
      contactIds: [],
      eventKey: r.calendarEventKey,
    },
  }));
}

/**
 * Granola notes, one row per saved batch the sync wrote (`ingestNote`). A note that named
 * nobody is never saved, so it is not here either. The date is the meeting's (every
 * interaction of a batch carries it); grouped rather than a correlated subquery, which
 * drizzle renders unqualified in a projection.
 */
async function listGranola(
  userId: string,
  q: string,
  after: { at: string; id: string } | null,
  limit: number
): Promise<Ranked[]> {
  const db = await getDb();
  const at = sql`min(${interactions.interactionDate})`;
  const rows = await db
    .select({
      id: noteBatches.id,
      atMs: sql<number>`(extract(epoch from min(${interactions.interactionDate})) * 1000)::float8`.mapWith(Number),
      atText: sql<string>`min(${interactions.interactionDate})::text`,
      sourceText: noteBatches.sourceText,
      result: noteBatches.result,
    })
    .from(interactions)
    .innerJoin(noteBatches, eq(noteBatches.id, interactions.noteBatchId))
    .where(
      and(
        eq(interactions.userId, userId),
        eq(interactions.source, "granola"),
        eq(noteBatches.userId, userId),
        eq(noteBatches.status, "saved"),
        q ? sql`${noteBatches.sourceText} ILIKE ${likePattern(q)}` : undefined
      )
    )
    .groupBy(noteBatches.id)
    .having(after ? sql`(${at}, ${noteBatches.id}) < (${after.at}::timestamptz, ${after.id}::uuid)` : undefined)
    .orderBy(desc(at), desc(noteBatches.id))
    .limit(limit + 1);

  return rows.map((r) => {
    const note = parseGranolaNote(r.sourceText);
    return {
      atMs: r.atMs,
      atText: r.atText,
      item: {
        id: r.id,
        source: "granola",
        title: note.title,
        startedAt: new Date(r.atMs).toISOString(),
        durationMs: 0,
        status: "saved",
        attendees: r.result.participants.map((p) => p.name).filter(Boolean),
        summary: listSummary(note.body),
        call: null,
        sharedScreen: false,
        companies: [],
        noteBatchId: r.id,
        match: q ? { startMs: 0, excerpt: excerptAround(r.sourceText, q) } : null,
      },
      hints: { emails: [], contactIds: r.result.participants.map((p) => p.contactId), eventKey: null },
    };
  });
}

// ── Row details: plain summary, call kind, company logos ─────────────────────────────

export type MeetingCompany = { name: string; domain: string };
/** A company that may be named in free text: by any alias, some only when capitalised. */
type NamedOrg = MeetingCompany & { aliases?: readonly string[]; capitalisedOnly?: readonly string[] };

/** The curated company this name IS (not one it merely contains: "Apple Bank" is not Apple). */
function curatedCompany(name: string): CuratedCompany | null {
  const key = brandKey(name);
  return key ? (CURATED_COMPANIES.find((c) => c.aliases.some((a) => brandKey(a) === key)) ?? null) : null;
}

/**
 * Curated companies for free-text matching, minus the tools a meeting is held or followed up
 * on, and with "Google Meet", "Google Doc" and the like blanked first (`withoutTools`): "ping
 * on Slack" or "share the Google Doc" names how people work, not who the meeting was with.
 * Attendee-derived logos are unaffected: someone at slack.com still shows Slack.
 */
const TOOL_COMPANIES = new Set(["Zoom", "Slack", "Notion", "Figma", "LinkedIn", "GitHub", "GitLab", "Atlassian", "Dropbox", "Discord", "Linear"]);
const CURATED_ORGS: NamedOrg[] = CURATED_COMPANIES.filter((c) => !TOOL_COMPANIES.has(c.name));
function withoutTools(text: string): string {
  return text.replace(
    /\b(?:Google (?:Meet|Docs?|Drive|Calendar|Sheets?|Slides|Forms?)|(?:Microsoft|MS) (?:Teams|Outlook|Word|Excel|PowerPoint|OneDrive))\b/gi,
    " "
  );
}

/** Where `org` is first named in `text` as a whole word, or -1. `hay` is ` ${brandKey(text)} `. */
function mentionAt(org: NamedOrg, text: string, hay: string): number {
  let best = -1;
  for (const alias of org.aliases ?? [org.name]) {
    const key = brandKey(alias);
    if (key.length < 3) continue;
    const at = hay.indexOf(` ${key} `);
    if (at < 0) continue;
    if (org.capitalisedOnly?.includes(alias)) {
      const exact = new RegExp(`(?<![\\p{L}\\p{N}])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u");
      if (!exact.test(text)) continue;
    }
    if (best < 0 || at < best) best = at;
  }
  return best;
}

/**
 * The companies a meeting involved, at most `max`, one per domain: its people's first, then
 * the user's own companies its title or summary names, then curated companies it names — each
 * group in the order mentioned. Names match as whole words, case-insensitively (an everyday-
 * word brand like Apple only when capitalised); names under three characters never match.
 */
export function meetingCompanies(
  people: MeetingCompany[],
  text: string,
  orgs: NamedOrg[],
  curated: NamedOrg[] = CURATED_ORGS,
  max = 2
): MeetingCompany[] {
  const out: MeetingCompany[] = [];
  const add = (c: MeetingCompany) => {
    if (out.length < max && !out.some((o) => o.domain === c.domain)) out.push({ name: c.name, domain: c.domain });
  };
  people.forEach(add);
  const plain = withoutTools(text);
  const hay = ` ${brandKey(plain)} `;
  for (const group of [orgs, curated]) {
    if (out.length >= max) break;
    group
      .map((o) => ({ o, at: mentionAt(o, plain, hay) }))
      .filter((h) => h.at >= 0)
      .sort((a, b) => a.at - b.at)
      .forEach((h) => add(h.o));
  }
  return out;
}

/**
 * Fills each kept row's `call` and `companies`, in four batched reads for the whole page:
 * the calendar events it was recorded from, its Granola people's contacts, the user's
 * companies whose names appear in any title or summary on it, and the user's own addresses
 * (their domains are the user's own company, which would otherwise badge every row).
 */
async function addCallsAndCompanies(userId: string, page: Ranked[]): Promise<void> {
  if (!page.length) return;
  const db = await getDb();
  const eventKeys = [...new Set(page.flatMap((r) => (r.hints.eventKey ? [r.hints.eventKey] : [])))];
  const contactIds = [...new Set(page.flatMap((r) => r.hints.contactIds))];
  const texts = new Map(page.map((r) => [r.item.id, `${r.item.title ?? ""} ${r.item.summary ?? ""}`]));
  // `name_normalized` is lowercased with collapsed spaces; a substring hit here is narrowed
  // to a whole-word one by `meetingCompanies`.
  const hay = [...texts.values()].join(" \n ").toLowerCase().replace(/\s+/g, " ");

  // Granola notes carry no event key: match them to a video-call invite by start time.
  const granolaAt = page.filter((r) => r.item.source === "granola").map((r) => r.atMs);
  const [events, people, mentioned, selfRows, granolaEvents] = await Promise.all([
    eventKeys.length
      ? db
          .selectDistinctOn([calendarEvents.providerEventId], {
            key: calendarEvents.providerEventId,
            kind: calendarEvents.conferenceKind,
          })
          .from(calendarEvents)
          .where(
            and(
              eq(calendarEvents.userId, userId),
              inArray(calendarEvents.providerEventId, eventKeys),
              isNotNull(calendarEvents.conferenceKind)
            )
          )
          .orderBy(calendarEvents.providerEventId)
      : [],
    contactOrgLogos(userId, contactIds),
    db
      .select({ name: companies.name, domain: orgBrandColors.domain })
      .from(companies)
      .leftJoin(
        orgBrandColors,
        and(eq(orgBrandColors.nameKey, companies.nameNormalized), eq(orgBrandColors.kind, "company"))
      )
      .where(
        and(
          eq(companies.userId, userId),
          sql`length(${companies.nameNormalized}) >= 3`,
          sql`position(${companies.nameNormalized} in ${hay}) > 0`
        )
      )
      .limit(200),
    db.execute(sql`
      SELECT email FROM user_settings WHERE user_id = ${userId}
      UNION SELECT email_address FROM gmail_connections WHERE user_id = ${userId}
      UNION SELECT email_address FROM outlook_connections WHERE user_id = ${userId}
      UNION SELECT email_address FROM apple_connections WHERE user_id = ${userId}
    `),
    granolaAt.length
      ? db
          .select({ atMs: sql<number>`(extract(epoch from ${calendarEvents.startAt}) * 1000)::float8`.mapWith(Number), kind: calendarEvents.conferenceKind })
          .from(calendarEvents)
          .where(
            and(
              eq(calendarEvents.userId, userId),
              isNotNull(calendarEvents.conferenceKind),
              sql`${calendarEvents.startAt} between ${new Date(Math.min(...granolaAt) - GRANOLA_EVENT_SLACK_MS).toISOString()}::timestamptz and ${new Date(Math.max(...granolaAt) + GRANOLA_EVENT_SLACK_MS).toISOString()}::timestamptz`
            )
          )
          .limit(500)
      : [],
  ]);

  const selfDomains = new Set(rowsOf<{ email: string | null }>(selfRows).flatMap((r) => toDomain(r.email) ?? []));
  const notSelf = (c: MeetingCompany) => !selfDomains.has(c.domain);
  const callByKey = new Map(events.map((e) => [e.key, e.kind]));
  const orgs = mentioned.flatMap((o) => {
    const domain = companyDomain(o.name, o.domain);
    return domain ? [{ name: o.name, domain }] : [];
  });

  for (const r of page) {
    const fromPeople = [
      ...r.hints.contactIds.flatMap((id) => people.get(id) ?? []),
      ...r.hints.emails.flatMap((email) => {
        const name = companyFromEmail(email);
        const domain = name ? toDomain(email) : null;
        return name && domain ? [{ name: curatedCompany(name)?.name ?? name, domain }] : [];
      }),
    ].filter(notSelf);
    r.item.call =
      r.item.source === "granola"
        ? nearestCall(r.atMs, granolaEvents)
        : ((r.hints.eventKey ? callByKey.get(r.hints.eventKey) : null) ?? r.item.call);
    r.item.companies = meetingCompanies(fromPeople, texts.get(r.item.id) ?? "", orgs);
  }
}

/**
 * Each contact's company — or, with none, their school — with a domain for its logo, in one
 * read. Shared by the meeting rows and the capture history rows. Contacts with nothing
 * logo-able are left out of the map.
 */
export async function contactOrgLogos(
  userId: string,
  contactIds: readonly string[]
): Promise<Map<string, MeetingCompany>> {
  const out = new Map<string, MeetingCompany>();
  if (!contactIds.length) return out;
  const db = await getDb();
  const schoolBrand = alias(orgBrandColors, "school_brand");
  const people = await db
    .select({
      id: contacts.id,
      company: contacts.company,
      email: contacts.email,
      school: contacts.school,
      domain: orgBrandColors.domain,
      schoolDomain: schoolBrand.domain,
    })
    .from(contacts)
    .leftJoin(companies, and(eq(companies.id, contacts.companyId), eq(companies.userId, userId)))
    .leftJoin(
      orgBrandColors,
      and(eq(orgBrandColors.nameKey, companies.nameNormalized), eq(orgBrandColors.kind, "company"))
    )
    // `name_key` is trimmed, lowercased and space-collapsed (see the table), computed here too.
    .leftJoin(
      schoolBrand,
      and(
        eq(schoolBrand.nameKey, sql`lower(regexp_replace(trim(${contacts.school}), '[[:space:]]+', ' ', 'g'))`),
        eq(schoolBrand.kind, "school")
      )
    )
    .where(and(eq(contacts.userId, userId), inArray(contacts.id, [...contactIds])));
  for (const p of people) {
    const company = p.company?.trim();
    const fromEmail = companyFromEmail(p.email);
    // Their email names the company only when it is the same one (not last job's address).
    const emailFits = fromEmail && (!company || brandKey(fromEmail) === brandKey(company));
    const name = company || fromEmail;
    const domain = (company ? companyDomain(company, p.domain) : null) ?? (emailFits ? toDomain(p.email) : null);
    if (name && domain) {
      out.set(p.id, { name, domain });
      continue;
    }
    const school = p.school?.trim();
    const schoolDomain = school ? companyDomain(school, p.schoolDomain) : null;
    if (school && schoolDomain) out.set(p.id, { name: school, domain: schoolDomain });
  }
  return out;
}

const GRANOLA_EVENT_SLACK_MS = 10 * 60_000;

/** The video call of the invite starting closest to `atMs`, within ten minutes; "other" is no call. */
export function nearestCall(atMs: number, events: readonly { atMs: number; kind: string | null }[]): string | null {
  let best: { gap: number; kind: string | null } | null = null;
  for (const e of events) {
    const gap = Math.abs(e.atMs - atMs);
    if (gap <= GRANOLA_EVENT_SLACK_MS && (!best || gap < best.gap)) best = { gap, kind: e.kind };
  }
  return best?.kind && best.kind !== "other" ? best.kind : null;
}

/** A company's website for its logo: what `org_brand_colors` learned, else a curated entry's own. */
function companyDomain(name: string, learned: string | null | undefined): string | null {
  return learned ? toDomain(learned) : (curatedCompany(name)?.domain ?? null);
}

export type GranolaNote = { title: string | null; attendees: string | null; body: string; myNotes: string | null };

/**
 * The text `noteText` (connectors/granola-xml.ts) wrote: "Meeting:", "When:" and
 * "Attendees:" lines, Granola's summary, then "My notes:" — each separated by a blank line.
 */
export function parseGranolaNote(text: string): GranolaNote {
  let rest = text;
  const header = (label: string): string | null => {
    const m = rest.match(new RegExp(`^${label}: (.*)(?:\\n\\n|$)`));
    if (!m) return null;
    rest = rest.slice(m[0].length);
    return m[1].trim() || null;
  };
  const title = header("Meeting");
  header("When");
  const attendees = header("Attendees");
  const at = rest.lastIndexOf("My notes:\n");
  const myNotes = at >= 0 ? rest.slice(at + "My notes:\n".length).trim() || null : null;
  const body = (at >= 0 ? rest.slice(0, at) : rest).trim();
  return { title, attendees, body, myNotes };
}

/** One Granola meeting for `/meetings/g/[id]`: null unless it is this user's saved Granola batch. */
export async function getGranolaMeeting(userId: string, batchId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) return null;
  const db = await getDb();
  const [row] = await db
    .select({
      id: noteBatches.id,
      atMs: sql<number>`(extract(epoch from min(${interactions.interactionDate})) * 1000)::float8`.mapWith(Number),
      sourceText: noteBatches.sourceText,
      result: noteBatches.result,
    })
    .from(interactions)
    .innerJoin(noteBatches, eq(noteBatches.id, interactions.noteBatchId))
    .where(
      and(
        eq(noteBatches.id, batchId),
        eq(noteBatches.userId, userId),
        eq(noteBatches.status, "saved"),
        eq(interactions.userId, userId),
        eq(interactions.source, "granola")
      )
    )
    .groupBy(noteBatches.id);
  if (!row) return null;
  return { id: row.id, at: new Date(row.atMs), note: parseGranolaNote(row.sourceText), result: row.result };
}

// ── Chat: passages across meetings ────────────────────────────────────────────────────

export type MeetingPassage = {
  meetingId: string;
  title: string | null;
  /** ISO. */
  date: string;
  /** Where in the meeting, for a transcript passage; null for a summary. */
  startMs: number | null;
  kind: "transcript" | "summary";
  snippet: string;
};

/** Words worth matching: three letters or more, and not filler. */
const FILLER = new Set([
  "the", "and", "for", "that", "with", "what", "did", "say", "said", "about", "was", "were",
  "has", "have", "how", "who", "when", "they", "them", "this", "from", "tell", "meeting",
  "meetings", "call", "talk", "talked",
]);

export function searchWords(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w.length >= 3 && !FILLER.has(w));
  return [...new Set(words)].slice(0, 6);
}

/**
 * The passages of a user's finished meetings that best match a question's keywords: the
 * transcript lines containing the most of them, and the summaries of meetings whose title,
 * summary or guest list mention them (so a name finds that person's meetings even when
 * nobody said it aloud). Newest first among equals.
 *
 * Transcript speakers are Deepgram's "Speaker 2", not names — a passage says WHEN in a
 * meeting something was said, never who said it.
 */
export async function searchMeetingPassagesFor(
  userId: string,
  opts: { query: string; after?: Date | null; before?: Date | null; limit?: number }
): Promise<MeetingPassage[]> {
  const words = searchWords(opts.query.slice(0, 300));
  if (!words.length) return [];
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 20);
  const db = await getDb();

  const base = [
    eq(meetingSessions.userId, userId),
    inArray(meetingSessions.status, LISTED),
    opts.after ? sql`${meetingSessions.startedAt} >= ${opts.after}` : undefined,
    opts.before ? sql`${meetingSessions.startedAt} < ${opts.before}` : undefined,
  ];
  const anyWord = (col: SQL) =>
    sql.join(
      words.map((w) => sql`${col} ILIKE ${likePattern(w)}`),
      sql` OR `
    );

  const lines = await db
    .select({
      meetingId: meetingSessions.id,
      title: meetingSessions.title,
      digestTitle: sql<string | null>`${meetingSessions.digest}->>'title'`,
      startedAt: meetingSessions.startedAt,
      startMs: meetingTranscriptSegments.startMs,
      text: meetingTranscriptSegments.text,
    })
    .from(meetingTranscriptSegments)
    .innerJoin(meetingSessions, eq(meetingSessions.id, meetingTranscriptSegments.sessionId))
    .where(
      and(
        ...base,
        eq(meetingTranscriptSegments.userId, userId),
        sql`(${anyWord(sql`${meetingTranscriptSegments.text}`)})`
      )
    )
    .orderBy(desc(meetingSessions.startedAt), meetingTranscriptSegments.seq)
    .limit(80);

  const scored: (MeetingPassage & { score: number })[] = lines.map((l) => {
    const lower = l.text.toLowerCase();
    return {
      meetingId: l.meetingId,
      title: l.title?.trim() || l.digestTitle?.trim() || null,
      date: l.startedAt.toISOString(),
      startMs: l.startMs,
      kind: "transcript",
      snippet: excerptAround(l.text, words.find((w) => lower.includes(w)) ?? words[0], 160),
      score: words.filter((w) => lower.includes(w)).length,
    };
  });

  const summaries = await db
    .select({
      meetingId: meetingSessions.id,
      title: meetingSessions.title,
      digestTitle: sql<string | null>`${meetingSessions.digest}->>'title'`,
      startedAt: meetingSessions.startedAt,
      summary: sql<string | null>`left(${meetingSessions.digest}->>'summary', 600)`,
      attendees: meetingSessions.attendees,
    })
    .from(meetingSessions)
    .where(
      and(
        ...base,
        sql`(${anyWord(sql`${meetingSessions.title}`)} OR ${anyWord(sql`${meetingSessions.digest}->>'summary'`)} OR ${anyWord(sql`${meetingSessions.attendees}::text`)})`
      )
    )
    .orderBy(desc(meetingSessions.startedAt))
    .limit(20);

  for (const m of summaries) {
    if (!m.summary) continue;
    const haystack = `${m.title ?? ""} ${m.summary} ${(m.attendees ?? []).map((a) => a.name).join(" ")}`.toLowerCase();
    scored.push({
      meetingId: m.meetingId,
      title: m.title?.trim() || m.digestTitle?.trim() || null,
      date: m.startedAt.toISOString(),
      startMs: null,
      kind: "summary",
      snippet: m.summary,
      // A summary that mentions the keywords outranks a stray line only when it mentions more.
      score: words.filter((w) => haystack.includes(w)).length - 0.5,
    });
  }

  return scored
    .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date) || (a.startMs ?? 0) - (b.startMs ?? 0))
    .slice(0, limit)
    .map((p) => ({ meetingId: p.meetingId, title: p.title, date: p.date, startMs: p.startMs, kind: p.kind, snippet: p.snippet }));
}
