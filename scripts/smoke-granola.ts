/**
 * Reading Granola's MCP answers (`src/lib/connectors/granola-xml.ts`). The fixtures copy the
 * real responses' shape — attributes, child tags, escaping — with made-up people and notes.
 */
import {
  connectedUserEmail,
  externalParticipants,
  mergeMeetingLists,
  nextCursor,
  noteText,
  parseFolders,
  parseMeetings,
  parseParticipants,
} from "../src/lib/connectors/granola-xml";
import { checker } from "./smoke/check";

const t = checker();

const LIST = `<requested_range time_range="custom" timezone="America/New_York">Queried meetings…</requested_range>

<meetings_data connected_user_email="me@example.com" workspace_name="Sam&apos;s workspace" from="Oct 30, 2026" to="Oct 30, 2026" count="2">
<meeting id="m-1" title="Chat with Ana/Sam" date="Oct 30, 2026 4:00 PM EDT" meeting_at="2026-10-30T16:00:00.000-04:00" updated_at="2026-10-30T16:40:00.000-04:00" captured_by_me="true" url="https://notes.granola.ai/d/m-1">
    <known_participants>
    Sam Lee (note creator) (Me@Example.com), Afox1 (afox1@example.com)
    </known_participants>
    <folders />
  </meeting>

<meeting id="m-2" title="Pat &amp; Sam" date="Oct 30, 2026 3:30 PM EDT" meeting_at="2026-10-30T15:30:00.000-04:00" updated_at="2026-10-30T16:00:23.140-04:00" captured_by_me="true">
    <known_participants>
    Sam Lee (note creator) (me@example.com), Pat Kim (pat@corp.example), pat@corp.example (pat@corp.example)
    </known_participants>
    <folders />
  </meeting>
</meetings_data>

<pagination has_more="true" total_count="4" remaining_count="2" next_cursor="abc123" />`;

const GET = `<connected_user_email>me@example.com</connected_user_email>

<meetings_data from="Oct 30, 2026" to="Oct 30, 2026" count="1">
<meeting id="m-2" title="Pat &amp; Sam" meeting_at="2026-10-30T15:30:00.000-04:00" created_at="2026-10-30T15:41:16.710-04:00" updated_at="2026-10-30T16:00:23.140-04:00">
  <known_participants>
  Sam Lee (note creator) (me@example.com), Pat Kim (pat@corp.example)
  </known_participants>
    <folders />
  <private_notes>
she runs demos &lt;fast&gt;
</private_notes>
  <summary>
# Demo process

- Pat wants faster environment setup
</summary>
</meeting>
</meetings_data>`;

// The list.
const listed = parseMeetings(LIST);
t.check("two meetings listed", listed.length === 2, String(listed.length));
t.check("full meeting time kept, offset and all", listed[0].meetingAt === "2026-10-30T16:00:00.000-04:00");
t.check("longer than a day-only date, so it isn't stored at noon", listed[0].meetingAt.length > 10);
t.check("updated_at read", listed[1].updatedAt === "2026-10-30T16:00:23.140-04:00");
t.check("title unescaped", listed[1].title === "Pat & Sam", listed[1].title);
t.check("connected email from the list attribute", connectedUserEmail(LIST) === "me@example.com");
t.check("next page cursor", nextCursor(LIST) === "abc123");
t.check("no cursor on the last page", nextCursor(LIST.replace('has_more="true"', 'has_more="false"')) === null);
t.check("no cursor without pagination", nextCursor(GET) === null);

// Participants.
const ps = parseParticipants("Sam Lee (note creator) (me@example.com), Afox1 (afox1@example.com), Solo Name");
t.check("one per email, name-only entries dropped", ps.length === 2, JSON.stringify(ps));
t.check("note-creator marker stripped from the name", ps[0].name === "Sam Lee", String(ps[0].name));
t.check("emails lower-cased", parseParticipants("X (Me@Example.com)")[0].email === "me@example.com");

// Who the note is about.
const ext = externalParticipants(listed[1], [connectedUserEmail(LIST)]);
t.check("the user is not an attendee of their own note", !ext.some((p) => p.email === "me@example.com"));
t.check("an email listed twice counts once", ext.length === 1 && ext[0].email === "pat@corp.example", JSON.stringify(ext));
t.check("own emails compare case-insensitively", externalParticipants(listed[0], ["ME@example.com"]).length === 1);

// The note body.
const [full] = parseMeetings(GET);
t.check("connected email from the get tag", connectedUserEmail(GET) === "me@example.com");
t.check("summary read", full.summary.startsWith("# Demo process"), full.summary);
t.check("private notes read and unescaped", full.privateNotes === "she runs demos <fast>", full.privateNotes);

const text = noteText(listed[0], externalParticipants(listed[0], ["me@example.com"]));
t.check("attendee display names are in the parsed text, so the unattended rule finds them", text.includes("Afox1 <afox1@example.com>"));
t.check("the user is not written into the text", !text.toLowerCase().includes("me@example.com"));
t.check("an empty note section is left out", !noteText(listed[0], []).includes("My notes"));

// Folders (JSON, unlike the meeting tools).
const page = parseFolders(
  JSON.stringify({
    count: 3,
    folders: [
      { id: "f-1", title: "Networking", note_count: 12, parent_folder_id: null },
      { id: "f-2", title: "  ", note_count: 0 },
      { title: "no id" },
    ],
    next_offset: 100,
  }),
);
t.check("folders with an id are read", page.folders.length === 2, JSON.stringify(page.folders));
t.check("title and count read", page.folders[0].title === "Networking" && page.folders[0].noteCount === 12);
t.check("a blank title gets a name", page.folders[1].title === "Untitled folder");
t.check("next page offset read", page.nextOffset === 100);
t.check("the empty answer seen live reads empty", parseFolders('{"count":0,"folders":[]}').folders.length === 0);
t.check("unreadable text is an empty list, not a throw", parseFolders("<error>nope</error>").folders.length === 0);

// A note in two chosen folders is synced once.
const merged = mergeMeetingLists([listed, [listed[1], full]]);
t.check("notes merged across folders by id", merged.length === 2 && merged.map((m) => m.id).join(",") === "m-1,m-2");

t.done("granola smoke tests");
