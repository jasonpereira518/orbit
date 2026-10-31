/**
 * Granola's MCP tools answer in XML-ish text, not JSON. These read the few fields the sync
 * needs out of `list_meetings` and `get_meetings`. Pure — no database, no network — so
 * `scripts/smoke-granola.ts` can pin them against fixtures shaped like the real responses.
 *
 * Regex rather than an XML parser: the shape is flat (one `<meeting>` per note, a handful of
 * named children), the content inside is escaped, and nothing here needs a DOM.
 */

export type GranolaParticipant = { name: string | null; email: string };

export type GranolaMeeting = {
  id: string;
  title: string;
  /** Full ISO timestamp with offset — the scheduled start, or note creation without an event. */
  meetingAt: string;
  /** Present when `list_meetings` was filtered with `updated_after`, and on `get_meetings`. */
  updatedAt: string | null;
  participants: GranolaParticipant[];
  privateNotes: string;
  summary: string;
};

export function unescapeXml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([\w-]+)="([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
}

function child(body: string, tag: string): string {
  const m = body.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? unescapeXml(m[1]).trim() : "";
}

/** `Jason Pereira (note creator) (j@x.com), Pbranson (p@y.com)` → one entry per email. */
export function parseParticipants(text: string): GranolaParticipant[] {
  const out: GranolaParticipant[] = [];
  for (const m of text.matchAll(/([^,()]*?)\s*(?:\(note creator\)\s*)?\(([^()\s,]+@[^()\s,]+)\)/g)) {
    const name = m[1].trim();
    out.push({ name: name || null, email: m[2].trim().toLowerCase() });
  }
  return out;
}

/** Works on both tools: the list carries the email as an attribute, `get_meetings` as a tag. */
export function connectedUserEmail(xml: string): string | null {
  const m =
    xml.match(/connected_user_email="([^"]+)"/) ?? xml.match(/<connected_user_email>([^<]+)<\/connected_user_email>/);
  return m ? unescapeXml(m[1]).trim().toLowerCase() : null;
}

export function parseMeetings(xml: string): GranolaMeeting[] {
  const out: GranolaMeeting[] = [];
  for (const m of xml.matchAll(/<meeting\s([^>]*)>([\s\S]*?)<\/meeting>/g)) {
    const a = attrs(m[1]);
    if (!a.id || !a.meeting_at) continue;
    out.push({
      id: a.id,
      title: a.title ?? "",
      meetingAt: a.meeting_at,
      updatedAt: a.updated_at ?? null,
      participants: parseParticipants(child(m[2], "known_participants")),
      privateNotes: child(m[2], "private_notes"),
      summary: child(m[2], "summary"),
    });
  }
  return out;
}

/** `list_meetings`' pagination element: the cursor for the next page, or null at the end. */
export function nextCursor(xml: string): string | null {
  const m = xml.match(/<pagination\s([^>]*)\/?>/);
  if (!m) return null;
  const a = attrs(m[1]);
  return a.has_more === "true" && a.next_cursor ? a.next_cursor : null;
}

/**
 * The attendees a note is about: everyone with an email except the user. "The user" is the
 * Granola account's email and any address the caller already knows is theirs. Not the note
 * creator: a note shared with the user was created by someone they met.
 */
export function externalParticipants(
  meeting: GranolaMeeting,
  ownEmails: Iterable<string | null | undefined>,
): GranolaParticipant[] {
  const own = new Set([...ownEmails].filter((e): e is string => Boolean(e)).map((e) => e.toLowerCase()));
  const seen = new Set<string>();
  return meeting.participants.filter((p) => {
    if (own.has(p.email) || seen.has(p.email)) return false;
    seen.add(p.email);
    return true;
  });
}

/**
 * The text capture's parse reads. Attendees are written into it so the people the parse
 * returns from them are "named in the doc" — the unattended accept rule refuses anyone the
 * text never mentions, and Granola's display names ("Pbranson") often appear nowhere else.
 */
export function noteText(meeting: GranolaMeeting, attendees: GranolaParticipant[]): string {
  const people = attendees.map((p) => (p.name ? `${p.name} <${p.email}>` : p.email)).join(", ");
  return [
    `Meeting: ${meeting.title}`,
    `When: ${meeting.meetingAt}`,
    people ? `Attendees: ${people}` : "",
    meeting.summary,
    meeting.privateNotes ? `My notes:\n${meeting.privateNotes}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export type GranolaFolder = { id: string; title: string; noteCount: number | null };

/**
 * `list_meeting_folders` answers in JSON, unlike the meeting tools: `{ count, folders: [...] }`,
 * plus `next_offset` when truncated. Anything unreadable is an empty list, not a throw — the
 * folder picker degrades to "All notes", which is also what Free Granola (no folder tools) gets.
 */
export function parseFolders(text: string): { folders: GranolaFolder[]; nextOffset: number | null } {
  try {
    const data = JSON.parse(text) as { folders?: unknown[]; next_offset?: unknown };
    const folders = (data.folders ?? []).flatMap((f) => {
      const o = (f ?? {}) as Record<string, unknown>;
      if (typeof o.id !== "string" || !o.id) return [];
      return [{
        id: o.id,
        title: typeof o.title === "string" && o.title.trim() ? o.title.trim() : "Untitled folder",
        noteCount: typeof o.note_count === "number" ? o.note_count : null,
      }];
    });
    return { folders, nextOffset: typeof data.next_offset === "number" ? data.next_offset : null };
  } catch {
    return { folders: [], nextOffset: null };
  }
}

/** Notes listed once per chosen folder, merged: one entry per note id. */
export function mergeMeetingLists(lists: GranolaMeeting[][]): GranolaMeeting[] {
  const byId = new Map<string, GranolaMeeting>();
  for (const list of lists) for (const m of list) if (!byId.has(m.id)) byId.set(m.id, m);
  return [...byId.values()];
}
