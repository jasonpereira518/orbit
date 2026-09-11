/**
 * Turning a pasted or uploaded guest list into attendee rows.
 *
 * This is the acquisition path that actually covers the common case. No platform exposes the
 * guest list of an event you merely attended — Luma's API key is scoped to a calendar you own,
 * Eventbrite's attendees endpoint needs organiser scope, and Partiful hides the invite list
 * from guests by design. So for anything you did not host, the list arrives by copy-paste,
 * CSV, or a screenshot run through the existing capture extraction.
 *
 * Pure: no network, no DB, no AI. The screenshot path resolves to text upstream and lands here
 * as a paste, so all three inputs converge on one parser and one output shape.
 */
import Papa from "papaparse";
import { attendeeIdentityKey } from "@/lib/events/identity";
import type { AttendeeRole } from "@/lib/events/types";
import type { EventSpeaker } from "@/lib/events/parse-page";

export type ParsedAttendee = {
  fullName: string | null;
  email: string | null;
  company: string | null;
  title: string | null;
  linkedinUrl: string | null;
  xHandle: string | null;
  /**
   * Optional because the paste and CSV paths cannot know it. The connectors and the page's
   * speaker line-up can, and until now both computed it and had it dropped on the way to
   * the database — `event_attendees.attendee_role` was NULL for every row ever written.
   */
  attendeeRole?: AttendeeRole | null;
  /**
   * The provider's own id for this guest (`evt-guest-…`, a Luma `usr-…`, an Eventbrite
   * attendee id). Only a connector knows it. It is the most stable handle on a person a
   * platform gives us — stable across a name change, a second registration, and a typo'd
   * email — so it is stored even though nothing reads it yet.
   */
  externalRef?: string | null;
  phone?: string | null;
  identityKey: string;
};

export type RosterParseResult = {
  attendees: ParsedAttendee[];
  /** Lines that carried nothing identifiable. Reported, never silently dropped. */
  skipped: number;
  /** Duplicate lines collapsed within this paste. */
  deduped: number;
};

/**
 * A room's worth of people, generously. Past this the input is a mistake — a whole CRM export
 * pasted into the wrong box — and accepting it would build a roster nobody can review.
 */
export const MAX_ROSTER_ROWS = 5_000;

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const LINKEDIN = /https?:\/\/(?:[\w-]+\.)?linkedin\.com\/in\/[^\s,;|]+/i;
const X_HANDLE = /(?:^|\s)@([A-Za-z0-9_]{2,15})(?:\s|$)/;

function clean(value: string | null | undefined): string | null {
  const text = value?.trim().replace(/\s+/g, " ") ?? "";
  return text.length > 0 ? text : null;
}

/**
 * A name has to contain a letter.
 *
 * Pasted lists carry separator debris — "???", "---", "1.", a stray emoji — and without this
 * each one becomes an attendee keyed `nm:???` that the user then has to delete by hand. Kept
 * here rather than in `attendeeIdentityKey` because that function mirrors ingest's and must
 * stay identical to it; this is a property of messy paste input specifically.
 */
function personName(value: string | null | undefined): string | null {
  const text = clean(value);
  return text && /\p{L}/u.test(text) ? text : null;
}

/**
 * Strip a trailing job/company clause off a name.
 *
 * Guest lists are written for humans, so a line is routinely "Ada Lovelace — Engineer at
 * Analytical". Splitting on the separator gives a usable name and often a title/company for
 * free; leaving it would make the name unmatchable against an existing contact.
 */
function splitNameClause(raw: string): { name: string | null; rest: string | null } {
  const parts = raw.split(/\s+[–—|]\s+|\s+-\s+|\s*,\s*/);
  const name = personName(parts[0] ?? null);
  const rest = clean(parts.slice(1).join(", ") || null);
  return { name, rest };
}

/** "Engineer at Analytical" -> title + company. Either half may be absent. */
function splitRole(raw: string | null): { title: string | null; company: string | null } {
  if (!raw) return { title: null, company: null };
  const at = /^(.*?)\s+(?:at|@)\s+(.+)$/i.exec(raw);
  if (at) return { title: clean(at[1]), company: clean(at[2]) };
  return { title: null, company: raw };
}

function finalize(rows: Array<Omit<ParsedAttendee, "identityKey">>): RosterParseResult {
  const attendees: ParsedAttendee[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let deduped = 0;

  for (const row of rows.slice(0, MAX_ROSTER_ROWS)) {
    const identityKey = attendeeIdentityKey(row);
    if (!identityKey) {
      skipped++;
      continue;
    }
    if (seen.has(identityKey)) {
      deduped++;
      continue;
    }
    seen.add(identityKey);
    attendees.push({ ...row, identityKey });
  }
  return { attendees, skipped, deduped };
}

/**
 * Parse a pasted list, one person per line.
 *
 * Handles the shapes people actually paste: bare names, `Name <email>`, `Name, Company`,
 * `Name — Title at Company`, tab-separated columns off a web table, and LinkedIn URLs mixed
 * in. Anything unrecognisable is counted as skipped rather than guessed at.
 */
export function parseRosterText(text: string): RosterParseResult {
  const rows: Array<Omit<ParsedAttendee, "identityKey">> = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // A leading bullet or list marker is noise from wherever this was copied.
    const body = line.replace(/^[-*•·\d]+[.)\]]?\s+/, "").trim();
    if (!body) continue;

    const email = clean(EMAIL.exec(body)?.[0] ?? null);
    const linkedinUrl = clean(LINKEDIN.exec(body)?.[0] ?? null);
    // Strip what we have already claimed so it cannot be mistaken for part of the name.
    let remainder = body;
    if (email) remainder = remainder.replace(email, " ");
    if (linkedinUrl) remainder = remainder.replace(linkedinUrl, " ");
    const xHandle = clean(X_HANDLE.exec(remainder)?.[1] ?? null);
    if (xHandle) remainder = remainder.replace(`@${xHandle}`, " ");
    // Angle brackets and separators left over from `Name <email>` shapes.
    remainder = remainder.replace(/[<>()]/g, " ").replace(/\s+/g, " ").trim();

    // Tabs mean this came off a table; treat the columns as name / role / company.
    const columns = rawLine.includes("\t")
      ? rawLine.split("\t").map((c) => clean(c))
      : null;

    if (columns && columns.filter(Boolean).length > 1) {
      const [rawName, second, third] = columns;
      const name = personName(rawName);
      const role = splitRole(second ?? null);
      rows.push({
        fullName: name,
        email,
        company: third ?? role.company,
        title: role.title ?? (third ? second ?? null : null),
        linkedinUrl,
        xHandle,
      });
      continue;
    }

    const { name, rest } = splitNameClause(remainder);
    const role = splitRole(rest);
    rows.push({
      fullName: name,
      email,
      company: role.company,
      title: role.title,
      linkedinUrl,
      xHandle,
    });
  }

  return finalize(rows);
}

/**
 * Header aliases, lowercased. Covers Luma, Eventbrite and Partiful exports plus the obvious.
 *
 * `attendeeRole` is omitted deliberately: a CSV's "role" column is a job title far more often
 * than it is host/speaker/attendee, and `title` already claims that header.
 *
 * `externalRef` is omitted for a different reason: a provider's guest id is only meaningful
 * alongside the provider that issued it, and a CSV does not say which one that is.
 */
const HEADERS: Record<
  keyof Omit<ParsedAttendee, "identityKey" | "attendeeRole" | "externalRef">,
  string[]
> = {
  fullName: ["name", "full name", "attendee name", "guest name", "first name"],
  email: ["email", "email address", "e-mail", "attendee email"],
  company: ["company", "organization", "organisation", "employer", "company name"],
  title: ["title", "job title", "role", "position", "headline"],
  linkedinUrl: ["linkedin", "linkedin url", "linkedin profile", "profile url"],
  xHandle: ["x", "twitter", "x handle", "twitter handle"],
  phone: ["phone", "phone number", "mobile", "cell phone", "telephone"],
};

function pick(row: Record<string, string>, keys: string[]): string | null {
  for (const key of keys) {
    const match = Object.keys(row).find((h) => h.trim().toLowerCase() === key);
    if (match) {
      const value = clean(row[match]);
      if (value) return value;
    }
  }
  return null;
}

/**
 * Parse a CSV export.
 *
 * Headers are matched by alias rather than position, so a Luma export and an Eventbrite one
 * both work without the user mapping columns by hand. A `First Name` / `Last Name` pair is
 * joined, because exports split them more often than not.
 */
export function parseRosterCsv(csvText: string): RosterParseResult {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
  });
  if (parsed.errors.length && parsed.data.length === 0) {
    throw new Error(parsed.errors[0]?.message || "Could not read that CSV.");
  }

  const rows = parsed.data.map((row) => {
    let fullName = personName(pick(row, HEADERS.fullName));
    const last = pick(row, ["last name", "surname", "family name"]);
    if (last && fullName && !fullName.includes(" ")) fullName = `${fullName} ${last}`;
    return {
      fullName,
      email: pick(row, HEADERS.email),
      company: pick(row, HEADERS.company),
      title: pick(row, HEADERS.title),
      linkedinUrl: pick(row, HEADERS.linkedinUrl),
      xHandle: pick(row, HEADERS.xHandle)?.replace(/^@/, "") ?? null,
      // Never an identity key — a phone number is stored as a detail only, so a column of
      // blank-ish values cannot silently key rows together.
      phone: pick(row, HEADERS.phone),
    };
  });

  return finalize(rows);
}

/**
 * A page's speaker line-up as roster rows.
 *
 * Produces the same `ParsedAttendee` shape as paste, CSV and the provider connectors, so
 * speakers converge on `upsertEventAttendees` and dedupe by identity key. That matters more
 * than it looks: a user who later pastes the real attendee list containing the same names
 * gets ONE row per person, enriched, rather than a duplicate beside the speaker row.
 *
 * A line-up gives a name and sometimes a link, so most rows key on `nm:<name>` — the weakest
 * identity `attendeeIdentityKey` issues. That is the honest tier for this data, and it is
 * why these rows arrive unconfirmed: `spoke_to` stays 0 and no contact exists until the user
 * says otherwise.
 *
 * A `performer` URL is a homepage as often as a profile, and there is no column for a
 * homepage — so it is claimed only when it is recognisably LinkedIn or X, and dropped
 * otherwise rather than stuffed into a field that means something else.
 */
/**
 * Drop the speakers who are already on this roster under any identity.
 *
 * A page gives a speaker a NAME and little else, so `speakersToAttendees` keys most of them
 * `nm:<name>` — the weakest tier. The moment the user corrects that row and adds an email,
 * its identity key legitimately becomes `em:…`, and the page's name-only key stops matching
 * it. Re-reading the page then misses the conflict target and inserts a SECOND row for
 * somebody the user has already curated.
 *
 * That is tolerable once, on a manual paste. It is not tolerable on a Refresh button, which
 * would manufacture a fresh duplicate every single time it is pressed.
 *
 * So page speakers are filtered by name against the roster before they are written. This is a
 * name comparison, which this codebase otherwise refuses — see `DUPLICATE_MERGE_CONFIDENCE`
 * and the 0.85 floor. The difference is what the comparison is used FOR: nothing is merged
 * here, and no two records are folded together. It only decides whether to SKIP an insert
 * inside one event's guest list. Its false positive is "a genuine second speaker with the
 * same name was not auto-added", which the user can add by hand; the alternative's false
 * positive is a duplicate appearing on every refresh forever.
 */
export function speakersNotOnRoster(
  speakers: ParsedAttendee[],
  existingNames: Array<string | null>
): ParsedAttendee[] {
  const known = new Set(
    existingNames
      .map((name) => name?.trim().toLowerCase().replace(/\s+/g, " "))
      .filter((name): name is string => Boolean(name))
  );
  return speakers.filter((speaker) => {
    const key = speaker.fullName?.trim().toLowerCase().replace(/\s+/g, " ");
    return !key || !known.has(key);
  });
}

export function speakersToAttendees(speakers: EventSpeaker[]): ParsedAttendee[] {
  const out: ParsedAttendee[] = [];
  const seen = new Set<string>();

  for (const speaker of speakers) {
    let linkedinUrl: string | null = null;
    let xHandle: string | null = null;
    if (speaker.url) {
      try {
        const parsed = new URL(speaker.url);
        const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
        if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
          linkedinUrl = parsed.href;
        } else if (host === "x.com" || host === "twitter.com") {
          xHandle = parsed.pathname.split("/").filter(Boolean)[0]?.replace(/^@/, "") ?? null;
        }
      } catch {
        // A malformed URL costs the link, never the speaker.
      }
    }

    const identityKey = attendeeIdentityKey({
      linkedinUrl,
      xHandle,
      fullName: speaker.name,
    });
    if (!identityKey || seen.has(identityKey)) continue;
    seen.add(identityKey);

    out.push({
      fullName: speaker.name,
      email: null,
      company: null,
      title: null,
      linkedinUrl,
      xHandle,
      attendeeRole: "speaker",
      identityKey,
    });
  }

  return out;
}

/**
 * The people a platform's own page names — hosts, and the guests a host featured.
 *
 * Richer than a JSON-LD speaker: these carry the platform's user id and, on Luma, a LinkedIn
 * handle. That matters more than it sounds. A name-only row keys as `nm:<name>`, the weakest
 * identity there is, so it cannot be matched to a contact with any confidence and cannot be
 * recognised as the same person at a second event. A LinkedIn URL keys at the top tier, which
 * is what makes "you keep running into this person" possible at all.
 *
 * `externalRef` carries the platform id (`luma:usr-…`) rather than the bare value, because a
 * Luma user id and a Partiful user id are only unique within their own platform.
 */
export function peopleToAttendees(
  people: Array<{
    name: string;
    externalRef: string | null;
    linkedinUrl: string | null;
    xHandle: string | null;
  }>,
  role: AttendeeRole,
  platform?: string | null
): ParsedAttendee[] {
  const out: ParsedAttendee[] = [];
  const seen = new Set<string>();

  for (const item of people) {
    const identityKey = attendeeIdentityKey({
      linkedinUrl: item.linkedinUrl,
      xHandle: item.xHandle,
      fullName: item.name,
    });
    if (!identityKey || seen.has(identityKey)) continue;
    seen.add(identityKey);

    out.push({
      fullName: item.name,
      email: null,
      company: null,
      title: null,
      linkedinUrl: item.linkedinUrl,
      xHandle: item.xHandle,
      attendeeRole: role,
      externalRef:
        item.externalRef && platform ? `${platform}:${item.externalRef}` : item.externalRef,
      identityKey,
    });
  }

  return out;
}
