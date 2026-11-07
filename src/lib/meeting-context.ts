/**
 * Everything worth knowing before one meeting — read by the `meeting_context` chat tool and
 * by the prep card (`getMeetingPrep`). No model call: it is the stored brief, the dated
 * history and what is open, so the card costs nothing and the tool answers in one round.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, lt, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  actionItems,
  calendarEvents,
  contactBriefs,
  contacts,
  interactions,
  meetingSessions,
  memoryChunks,
  reminders,
  userSettings,
} from "@/db/schema";
import { briefOf, companyFromEmail, guestSubject, type GuestBrief } from "@/lib/guest-profiles";
import { listUpcomingEvents, relinkEvents, type CalendarEventRow } from "@/lib/calendar-events";
import { resolveTimeZone, ymdInZone } from "@/lib/reminder-due-bucket";
import { lastSeriesMeeting, loadMeetingSelf } from "@/lib/meeting-sessions";
import { matchContactsByName } from "@/lib/chat-lanes";
import { updateContactForUser } from "@/lib/contact-writes";
import {
  loadResearchedPeople,
  personResearchKey,
  researchPerson,
  type PersonResearcher,
} from "@/lib/web-research";
import { extractEventLinks, platformOf } from "@/lib/events/platforms";
import { canonicalEventKey } from "@/lib/events/discovery/keys";
import { combineResolutions, resolveAliases } from "@/lib/events/discovery/aliases";
import type { AliasKey } from "@/lib/events/discovery/types";
import { getEventForUser, listRosterForUser } from "@/lib/events/store";
import { whoToTalkTo, type WhoToTalkToRow } from "@/lib/events/who-to-talk-to";

import { isHandle } from "@/lib/contact-name-guess";
export { isHandle };

/** Capitalised words in an invite title that are not names. */
const NOT_NAMES = new Set(
  "chat sync call meeting meet intro catch catchup coffee lunch dinner drinks with and the re fwd fw for about on of weekly quick zoom teams interview check in hangout demo review prep standup x".split(" ")
);

/** "Chat with David/Jason", for user Jason → ["David"]. */
export function titleNames(title: string, self: string[]): string[] {
  const mine = new Set(self.map((n) => n.trim().toLowerCase()).filter(Boolean));
  const out: string[] = [];
  for (const w of title.split(/[^\p{L}'’-]+/u)) {
    const lw = w.toLowerCase();
    if (w.length < 2 || !/^\p{Lu}/u.test(w) || NOT_NAMES.has(lw) || mine.has(lw)) continue;
    if (!out.some((o) => o.toLowerCase() === lw)) out.push(w);
  }
  return out;
}

const cap = (w: string) => w[0]!.toUpperCase() + w.slice(1);

/**
 * How a title name reads an address: "david.craver" and "davidcraver" are David Craver
 * (`full`); "dmcraver" is only David — a middle initial and a surname cannot be told apart.
 */
function readAddress(name: string, email: string): { name: string; full: boolean } | null {
  const n = name.toLowerCase();
  const local = (email.split("@")[0] ?? "").toLowerCase();
  const parts = local.split(/[._-]+/).map((p) => p.replace(/[^a-z]/g, "")).filter(Boolean);
  if (parts.length >= 2 && parts[0] === n) return { name: `${name} ${cap(parts[parts.length - 1]!)}`, full: true };
  const letters = local.replace(/[^a-z]/g, "");
  if (letters.startsWith(n)) {
    const rest = letters.slice(n.length);
    return rest.length >= 3 ? { name: `${name} ${cap(rest)}`, full: true } : { name, full: false };
  }
  if (letters.length >= 4 && letters[0] === n[0]) return { name, full: false };
  return null;
}

/**
 * Title names on guests whose own name is a handle, by lower-cased email. Only a one-to-one
 * fit pairs: two guests who could be David, or one guest who could be David or Dana, pair none.
 */
export function pairNames(
  names: string[],
  attendees: Array<{ name: string; email: string }>
): Map<string, { name: string; full: boolean }> {
  const fits = names.map((n) =>
    attendees
      .filter((a) => a.email && isHandle(a.name, a.email))
      .map((a) => ({ email: a.email.toLowerCase(), read: readAddress(n, a.email) }))
      .filter((f): f is { email: string; read: { name: string; full: boolean } } => f.read !== null)
  );
  const out = new Map<string, { name: string; full: boolean }>();
  fits.forEach((f, i) => {
    if (f.length !== 1) return;
    const claimed = fits.some((g, j) => j !== i && g.some((x) => x.email === f[0]!.email));
    if (!claimed) out.set(f[0]!.email, f[0]!.read);
  });
  return out;
}

/** Live web searches one prep may start; everyone else reads only what was already researched. */
const MAX_PREP_RESEARCH = 2;

/** The user's own zone, as Settings/Radar last saw it; UTC until then. */
export async function userTimeZone(userId: string): Promise<string> {
  const db = await getDb();
  const settings = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { radarDigestTz: true },
  });
  return resolveTimeZone(settings?.radarDigestTz);
}

/** One calendar event as the calendar tools return it: local times, no emails. */
export function eventView(e: CalendarEventRow, tz: string) {
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return {
    eventId: e.id,
    title: e.title,
    day: ymdInZone(e.startAt, tz),
    start: e.allDay ? "all day" : when.format(e.startAt),
    end: e.endAt && !e.allDay ? when.format(e.endAt) : null,
    timeZone: tz,
    location: e.location,
    call: e.conferenceKind,
    response: e.selfResponse,
    // Never the address: these go to the chat model and over MCP. A guest with no display name
    // is "Guest" unless they are a contact (their name then comes from get_contact).
    attendees: e.attendees.map((a) => ({
      name: a.name || "Guest",
      contactId: a.contactId,
      ...(a.response ? { response: a.response } : {}),
    })),
    attendeeCount: e.attendeeCount,
    guestListHidden: e.guestsHidden,
  };
}

/** "15:00" in `tz` for an instant — what "my 3pm" is matched against. */
export function hhmmInZone(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

export type MeetingSelector = { eventId?: string; time?: string; day?: string; query?: string };

export type MeetingPerson = {
  contactId: string;
  name: string;
  /** A search anchor for research, never fetched by Orbit. */
  linkedinUrl: string | null;
  /** Named in the invite title rather than on the guest list. */
  fromTitle: boolean;
  /** What a confident web search found about them. */
  profile: GuestBrief | null;
  company: string | null;
  title: string | null;
  standing: string | null;
  nextStep: string | null;
  recent: Array<{ day: string | null; type: string; summary: string | null }>;
  /** To-dos with this person due on or before the meeting starts — the ones to close first. */
  dueBefore: string[];
  open: string[];
  /** The latest things the user's own notes say involving them, newest first. */
  fromNotes: Array<{ day: string | null; snippet: string }>;
};

export type GuestNotInOrbit = {
  name: string;
  email: string;
  /** From the email domain (free); null for gmail.com and friends. */
  company: string | null;
  /** What a "Look up" (Find people's research) found, when one was run and was sure. */
  profile: GuestBrief | null;
};

/**
 * The Luma/Partiful/Eventbrite event behind a calendar invite. A platform invite carries one
 * guest — the user — so without this, prep for a party says nothing about who will be there.
 * Names only: this goes to the chat model.
 */
export type LinkedEvent = {
  eventId: string;
  title: string;
  url: string | null;
  hosts: string[];
  /** What the page said ("120 going"), else the roster we hold. */
  guestCount: number | null;
  rosterSize: number;
  when: "upcoming" | "past";
  worthFinding: Array<Pick<WhoToTalkToRow, "name" | "company" | "title" | "contactId" | "bucket">>;
};

/**
 * Resolved through the same alias keys discovery wrote: the invite's own UID (`gcal:` from
 * Google, `ics:` from every other feed) and any event link in its location or agenda.
 */
export async function linkedEventFor(
  userId: string,
  e: Pick<CalendarEventRow, "icalUid" | "location" | "agenda">
): Promise<LinkedEvent | null> {
  const keys: AliasKey[] = [];
  for (const href of extractEventLinks(`${e.location ?? ""}\n${e.agenda ?? ""}`, { max: 3 })) {
    const match = platformOf(href);
    if (match?.providerEventId) keys.push({ kind: "provider", value: `${match.platform}:${match.providerEventId}` });
    const url = canonicalEventKey(href);
    if (url) keys.push({ kind: "url", value: url });
  }
  if (e.icalUid) {
    keys.push({ kind: "source_ref", value: `gcal:${e.icalUid}` }, { kind: "source_ref", value: `ics:${e.icalUid}` });
  }
  if (!keys.length) return null;
  const hit = combineResolutions(keys, await resolveAliases(userId, keys));
  if (!hit.eventId || hit.dismissed) return null;
  const record = await getEventForUser(userId, hit.eventId);
  if (!record) return null;
  const roster = await listRosterForUser(userId, record.id);
  const ranked = roster.length ? await whoToTalkTo(userId, record, { limit: 5 }) : null;
  const hosts = roster
    .filter((r) => r.attendeeRole === "host" || r.attendeeRole === "speaker")
    .map((r) => r.fullName)
    .filter((n): n is string => !!n);
  if (record.organizerName && !hosts.includes(record.organizerName)) hosts.unshift(record.organizerName);
  return {
    eventId: record.id,
    title: record.title,
    url: record.url,
    hosts: hosts.slice(0, 6),
    guestCount: record.attendeeCount ?? (roster.length || null),
    rosterSize: roster.length,
    when: ranked?.when ?? (record.startsAt && record.startsAt.getTime() < Date.now() ? "past" : "upcoming"),
    worthFinding: (ranked?.rows ?? [])
      .filter((r) => r.bucket !== "skip")
      .map(({ name, company, title, contactId, bucket }) => ({ name, company, title, contactId, bucket })),
  };
}

/**
 * One meeting and its people. By id, by local start time (and day), by title words, or — with
 * none of those — the next meeting with someone the user knows. Null when nothing matches.
 */
export async function getMeetingContext(
  userId: string,
  sel: MeetingSelector,
  now: Date,
  /**
   * `research`: search the web for up to two people with nothing researched yet (chat's
   * prep). Off, only briefs already in the cache are read — the prep card never spends.
   */
  opts: { research?: boolean; researcher?: PersonResearcher; signal?: AbortSignal } = {}
): Promise<{
  event: CalendarEventRow;
  tz: string;
  people: MeetingPerson[];
  notInOrbit: GuestNotInOrbit[];
  /** For a recurring meeting that was recorded before: what the last one decided and left open. */
  lastTime: { day: string; decisions: string[]; actionItems: string[] } | null;
  linkedEvent: LinkedEvent | null;
  /** People on it with nothing to research them by (no company, work address or LinkedIn). */
  unresearched: string[];
} | null> {
  const tz = await userTimeZone(userId);
  const all = await listUpcomingEvents(userId, {
    from: new Date(now.getTime() - 2 * 86_400_000),
    to: new Date(now.getTime() + 14 * 86_400_000),
    limit: 200,
  });
  // Started up to an hour ago still counts as "my next meeting" — they may be in it.
  const soon = all.filter((e) => !e.allDay && (e.endAt ?? e.startAt).getTime() > now.getTime() - 3_600_000);
  const words = (sel.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const found = sel.eventId
    ? all.find((e) => e.id === sel.eventId)
    : sel.time
      ? soon.find((e) => hhmmInZone(e.startAt, tz) === sel.time && (!sel.day || ymdInZone(e.startAt, tz) === sel.day))
      : words.length
        ? soon.find((e) => words.every((w) => e.title.toLowerCase().includes(w)))
        : soon.find((e) => e.startAt.getTime() > now.getTime() - 3_600_000 && e.attendees.some((a) => a.contactId));
  if (!found) return null;
  const [linked] = await relinkEvents(userId, [found]);

  // Names: Google leaves a guest with no display name blank, and calendar ingest names such a
  // contact after their address. The invite title usually says who it is with.
  const self = await loadMeetingSelf(userId);
  const names = titleNames(linked.title, [self.firstName ?? "", self.lastName ?? ""]);
  const paired = pairNames(names, linked.attendees);
  const pairedFirst = new Set([...paired.values()].map((p) => p.name.split(" ")[0]!.toLowerCase()));
  const onInvite = new Set(linked.attendees.map((a) => a.contactId).filter(Boolean));
  // A title name nobody on the invite answers to: the one contact by that first name, if one.
  const titled = (
    await Promise.all(
      names
        .filter((n) => !pairedFirst.has(n.toLowerCase()))
        .slice(0, 2)
        .map(async (n) => {
          const { strong } = await matchContactsByName(userId, n).catch(() => ({ strong: [] as { id: string; name: string }[] }));
          const hits = strong.filter((h) => h.name.split(/\s+/)[0]!.toLowerCase() === n.toLowerCase());
          return hits.length === 1 && !onInvite.has(hits[0]!.id) ? hits[0]!.id : null;
        })
    )
  ).filter((id): id is string => !!id);
  const event: CalendarEventRow = {
    ...linked,
    attendees: linked.attendees.map((a) => {
      const pair = paired.get(a.email.toLowerCase());
      return isHandle(a.name, a.email) && pair ? { ...a, name: pair.name } : a;
    }),
  };

  const ids = [
    ...new Set([...event.attendees.map((a) => a.contactId).filter((c): c is string => !!c), ...titled]),
  ].slice(0, 8);
  const strangers = event.attendees.filter((a) => !a.contactId).slice(0, 10);
  // Read beside everything below; a failure only means no event block on the prep.
  const linkedEventP = linkedEventFor(userId, event).catch(() => null);
  const notInOrbit: GuestNotInOrbit[] = strangers.map((a) => ({
    name: isHandle(a.name, a.email) ? "" : a.name,
    email: a.email,
    company: companyFromEmail(a.email),
    profile: null,
  }));
  const last = event.seriesId ? await lastSeriesMeeting(userId, event.seriesId) : null;
  const lastTime = last
    ? {
        day: ymdInZone(last.startedAt, tz),
        decisions: last.decisions,
        actionItems: last.actionItems.map((a) => (a.owner ? `${a.text} — ${a.owner === "me" ? "you" : a.owner}` : a.text)),
      }
    : null;
  // With no contact on it the reads below are `false` queries: cheap, and research still runs.
  const db = await getDb();
  const [unorderedPeople, briefs, todos, items, recent, notes] = await Promise.all([
    db.query.contacts.findMany({
      where: and(eq(contacts.userId, userId), inArray(contacts.id, ids)),
      columns: { id: true, fullName: true, preferredName: true, email: true, company: true, title: true, linkedinUrl: true },
    }),
    db.query.contactBriefs.findMany({
      where: and(eq(contactBriefs.userId, userId), inArray(contactBriefs.contactId, ids)),
      columns: { contactId: true, standing: true, nextStep: true },
    }),
    db.query.reminders.findMany({
      where: and(
        eq(reminders.userId, userId),
        inArray(reminders.contactId, ids),
        eq(reminders.status, "pending"),
        // Not the meeting's own prep/follow-up reminders: those are about this event.
        isNull(reminders.calendarEventKey)
      ),
      columns: { contactId: true, title: true, dueDate: true },
      orderBy: [asc(reminders.dueDate)],
      limit: 40,
    }),
    db.query.actionItems.findMany({
      where: and(eq(actionItems.userId, userId), inArray(actionItems.contactId, ids), eq(actionItems.status, "open")),
      columns: { contactId: true, text: true },
      limit: 40,
    }),
    Promise.all(
      ids.map((id) =>
        db.query.interactions.findMany({
          // The past only: calendar sync logs this very meeting as an interaction too.
          where: and(
            eq(interactions.userId, userId),
            eq(interactions.contactId, id),
            lte(interactions.interactionDate, now)
          ),
          orderBy: [desc(interactions.interactionDate)],
          limit: 3,
          columns: { interactionType: true, interactionDate: true, aiSummary: true },
        })
      )
    ),
    // What the user's own notes say with them in it. Lexical-free and embedding-free: just the
    // newest passages that name them (the contacts GIN index), never the generated brief.
    Promise.all(
      ids.map((id) =>
        db
          .select({ occurredAt: memoryChunks.occurredAt, content: memoryChunks.content })
          .from(memoryChunks)
          .where(
            and(
              eq(memoryChunks.userId, userId),
              sql`${memoryChunks.contactIds} && array[${id}]::uuid[]`,
              ne(memoryChunks.sourceKind, "brief")
            )
          )
          .orderBy(sql`${memoryChunks.occurredAt} desc nulls last`)
          .limit(2)
      )
    ),
  ]);
  // In the order the meeting names them (`ids`), not whatever order the scan returned: the
  // research below takes the first few without a profile, so an unordered read made which
  // contact got the last search slot depend on the query plan.
  const people = [...unorderedPeople].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  const notesBy = new Map(notes.map((rows, i) => [ids[i], rows]));
  const snippet = (text: string) => {
    const t = text.replace(/\s+/g, " ").trim();
    return t.length > 180 ? `${t.slice(0, 177)}…` : t;
  };
  const recentBy = new Map(recent.map((rows, i) => [ids[i], rows]));

  // The best name for each contact: never a handle when anything better is known.
  const attendeeOf = new Map(event.attendees.filter((a) => a.contactId).map((a) => [a.contactId!, a]));
  const nameOf = (c: (typeof people)[number]) => {
    const a = attendeeOf.get(c.id);
    return (
      c.preferredName?.trim() ||
      (isHandle(c.fullName, c.email) ? null : c.fullName) ||
      (a && !isHandle(a.name, a.email) ? a.name : null) ||
      c.fullName
    );
  };

  // Research. Everyone with something to search by reads what was already found; with
  // `research`, up to two with nothing yet are searched — strangers first, the least known. A
  // guest is searched by name and the company their address names (never the address); a
  // contact by name with their company or LinkedIn.
  const subjects = [
    ...notInOrbit.map((g) => ({
      ref: `e:${g.email.toLowerCase()}`,
      who: g.name || "A guest",
      input: guestSubject(g.name, g.email),
    })),
    ...people.map((c) => {
      const name = nameOf(c);
      return {
        ref: `c:${c.id}`,
        who: name,
        input:
          c.linkedinUrl || (c.company && !isHandle(name, c.email))
            ? { fullName: name, company: c.company ?? undefined, linkedinUrl: c.linkedinUrl ?? undefined }
            : null,
      };
    }),
  ].map((s) => ({ ...s, key: s.input ? personResearchKey(s.input) : null }));
  const cached = await loadResearchedPeople(userId, subjects.flatMap((s) => (s.key ? [s.key] : [])));
  const profiles = new Map<string, GuestBrief | null>();
  for (const s of subjects) {
    const d = s.key ? cached.get(s.key) : undefined;
    if (d) profiles.set(s.ref, briefOf(s.key!, d));
  }
  if (opts.research) {
    const todo = subjects.filter((s) => s.key && !profiles.has(s.ref)).slice(0, MAX_PREP_RESEARCH);
    await Promise.all(
      todo.map(async (s) => {
        const res = await researchPerson(userId, s.input!, { researcher: opts.researcher, signal: opts.signal }).catch(
          () => null
        );
        profiles.set(s.ref, res?.ok ? briefOf(res.key, res.dossier) : null);
      })
    );
  }
  const unresearched = subjects.filter((s) => !s.key).map((s) => s.who);
  for (const g of notInOrbit) g.profile = profiles.get(`e:${g.email.toLowerCase()}`) ?? null;

  // Full names over handles, kept: a contact saved as "dmcraver" becomes David Craver once the
  // invite or their own profile says so. Only ever a handle is replaced.
  for (const c of people) {
    if (!isHandle(c.fullName, c.email)) continue;
    const a = attendeeOf.get(c.id);
    const pair = a ? paired.get(a.email.toLowerCase()) : undefined;
    const fromWeb = profiles.get(`c:${c.id}`)?.name ?? null;
    const first = pair?.name.split(" ")[0]!.toLowerCase();
    const better =
      (a && !isHandle(a.name, a.email) && a.name.includes(" ") ? a.name : null) ??
      (pair?.full ? pair.name : null) ??
      (fromWeb?.includes(" ") && (!first || fromWeb.toLowerCase().startsWith(first)) ? fromWeb : null);
    if (!better) continue;
    try {
      await updateContactForUser(userId, c.id, { fullName: better }, { skipRevalidate: true, skipSummary: true, skipCloseness: true });
      c.fullName = better;
    } catch {
      // Best effort: the prep still shows the better name.
    }
  }

  const byId = new Map(people.map((c) => [c.id, c]));
  return {
    // The invite as the contacts' names have it — never "Guest" for someone Orbit knows.
    event: {
      ...event,
      attendees: event.attendees.map((a) => {
        const c = a.contactId ? byId.get(a.contactId) : undefined;
        return c ? { ...a, name: nameOf(c) } : a;
      }),
    },
    tz,
    notInOrbit,
    lastTime,
    linkedEvent: await linkedEventP,
    unresearched,
    people: people.map((c) => {
      const brief = briefs.find((b) => b.contactId === c.id);
      return {
        contactId: c.id,
        name: nameOf(c),
        linkedinUrl: c.linkedinUrl,
        fromTitle: !attendeeOf.has(c.id),
        profile: profiles.get(`c:${c.id}`) ?? null,
        company: c.company,
        title: c.title,
        standing: brief?.standing ?? null,
        nextStep: brief?.nextStep ?? null,
        recent: (recentBy.get(c.id) ?? []).map((i) => ({
          day: i.interactionDate ? ymdInZone(i.interactionDate, tz) : null,
          type: i.interactionType,
          summary: i.aiSummary,
        })),
        dueBefore: todos
          .filter((t) => t.contactId === c.id && t.dueDate && t.dueDate.getTime() <= event.startAt.getTime())
          .map((t) => t.title)
          .slice(0, 5),
        open: [
          ...todos
            .filter((t) => t.contactId === c.id && !(t.dueDate && t.dueDate.getTime() <= event.startAt.getTime()))
            .map((t) => t.title),
          ...items.filter((t) => t.contactId === c.id).map((t) => t.text),
        ].slice(0, 5),
        fromNotes: (notesBy.get(c.id) ?? []).map((n) => ({
          day: n.occurredAt ? ymdInZone(n.occurredAt, tz) : null,
          snippet: snippet(n.content),
        })),
      };
    }),
  };
}

/**
 * The next meeting with someone the user knows, starting within `withinMs` — for the app
 * pulse, which runs every 90 seconds per tab, so one indexed read, plus the contact re-match
 * when a meeting is near.
 */
export async function nextKnownMeeting(
  userId: string,
  now: Date,
  withinMs: number
): Promise<{ eventId: string; title: string; startIso: string; people: string[] } | null> {
  const db = await getDb();
  const rows = await db
    .select({
      id: calendarEvents.id,
      title: calendarEvents.title,
      startAt: calendarEvents.startAt,
      attendees: calendarEvents.attendees,
    })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.userId, userId),
        gt(calendarEvents.startAt, now),
        lt(calendarEvents.startAt, new Date(now.getTime() + withinMs)),
        eq(calendarEvents.allDay, false),
        or(isNull(calendarEvents.selfResponse), ne(calendarEvents.selfResponse, "declined"))
      )
    )
    .orderBy(asc(calendarEvents.startAt))
    .limit(5);
  // Two small reads, only when a meeting is near: someone added since the last sync counts now.
  const linked = await relinkEvents(userId, rows);
  const e = linked.find((r) => r.attendees.some((a) => a.contactId));
  if (!e) return null;
  return {
    eventId: e.id,
    title: e.title,
    startIso: e.startAt.toISOString(),
    people: e.attendees
      .filter((a) => a.contactId)
      .map((a) => a.name || a.email)
      .slice(0, 4),
  };
}

/** Past this, "how did it go?" is history, not a question. */
const UNLOGGED_WITHIN_MS = 3 * 3_600_000;

/**
 * The meeting that just ended with someone the user knows and left no trace: not recorded, and
 * no note or log for those people since it started. For the app pulse's "How did it go?" card —
 * one indexed read, then two small ones only when there is a candidate.
 */
export async function lastUnloggedMeeting(
  userId: string,
  now: Date
): Promise<{ eventId: string; title: string; endIso: string; people: string[] } | null> {
  const db = await getDb();
  const rows = await db
    .select({
      id: calendarEvents.id,
      providerEventId: calendarEvents.providerEventId,
      title: calendarEvents.title,
      startAt: calendarEvents.startAt,
      endAt: calendarEvents.endAt,
      attendees: calendarEvents.attendees,
      attendeeCount: calendarEvents.attendeeCount,
    })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.userId, userId),
        lte(calendarEvents.endAt, now),
        gte(calendarEvents.endAt, new Date(now.getTime() - UNLOGGED_WITHIN_MS)),
        eq(calendarEvents.allDay, false),
        or(isNull(calendarEvents.selfResponse), ne(calendarEvents.selfResponse, "declined"))
      )
    )
    .orderBy(desc(calendarEvents.endAt))
    .limit(5);
  // A real meeting: someone known on it, and small enough to be a conversation.
  const e = rows.find((r) => r.attendeeCount > 0 && r.attendeeCount <= 8 && r.attendees.some((a) => a.contactId));
  if (!e || !e.endAt) return null;
  const ids = e.attendees.map((a) => a.contactId).filter((c): c is string => !!c);
  const [recorded, logged] = await Promise.all([
    db
      .select({ id: meetingSessions.id })
      .from(meetingSessions)
      .where(and(eq(meetingSessions.userId, userId), eq(meetingSessions.calendarEventKey, e.providerEventId)))
      .limit(1),
    db
      .select({ id: interactions.id })
      .from(interactions)
      .where(
        and(
          eq(interactions.userId, userId),
          inArray(interactions.contactId, ids),
          gte(interactions.createdAt, e.startAt),
          // Calendar sync logs the meeting itself; that is not the user writing anything down.
          or(isNull(interactions.source), ne(interactions.source, "google_calendar"))
        )
      )
      .limit(1),
  ]);
  if (recorded.length || logged.length) return null;
  return {
    eventId: e.id,
    title: e.title,
    endIso: e.endAt.toISOString(),
    people: e.attendees
      .filter((a) => a.contactId)
      .map((a) => a.name || a.email)
      .slice(0, 4),
  };
}
