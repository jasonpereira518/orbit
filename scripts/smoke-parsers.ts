import { parseLinkedInMessagesCsv, resolveConversations } from "../src/lib/linkedin-messages";
import { parseIcsEvents, peopleFromEvent } from "../src/lib/calendar-import";
import type { Contact } from "../src/db/schema";

const csv = `CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,DATE,SUBJECT,CONTENT
c1,Jane Doe,Jane Doe,https://www.linkedin.com/in/jane-doe,Me,2024-06-01 12:00:00 UTC,,Hey about the internship
c1,Jane Doe,Me,https://www.linkedin.com/in/me,Jane Doe,2024-06-02 12:00:00 UTC,,Thanks Jane!
c2,Alex Kim,Alex Kim,https://linkedin.com/in/alexkim,Me,2024-07-10T15:00:00Z,,Are you free next week?`;

const { messages } = parseLinkedInMessagesCsv(csv);
if (messages.length !== 3) throw new Error(`expected 3 messages, got ${messages.length}`);

const existing = [
  {
    id: "1",
    userId: "u",
    fullName: "Jane Doe",
    linkedinUrl: "https://www.linkedin.com/in/jane-doe",
    email: null,
    company: null,
    title: null,
  },
] as Contact[];

const conv = resolveConversations(
  messages,
  existing,
  "https://www.linkedin.com/in/me"
);
if (conv.length !== 2) throw new Error(`expected 2 conversations, got ${conv.length}`);
const jane = conv.find((c) => c.conversationTitle === "Jane Doe");
if (!jane?.match?.fullName) throw new Error("Jane should match existing contact");
const alex = conv.find((c) => c.conversationTitle === "Alex Kim");
if (alex?.match) throw new Error("Alex should be unmatched");

const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:abc
SUMMARY:Coffee with Jane
DTSTART:20240615T150000Z
DTEND:20240615T160000Z
ATTENDEE;CN=Jane Doe:mailto:jane@example.com
END:VEVENT
END:VCALENDAR`;

const events = parseIcsEvents(ics);
if (events.length !== 1) throw new Error(`expected 1 event, got ${events.length}`);
if (events[0].summary !== "Coffee with Jane") throw new Error("bad summary");
if (events[0].attendees[0]?.email !== "jane@example.com") {
  throw new Error("bad attendee email");
}

// Organizer also listed as an ATTENDEE — routine in real ICS exports (Google/Outlook both
// do this for the event creator). Without dedupe by resolved identity, `peopleFromEvent`
// would return this person twice, producing two identical `import_job_rows` for the same
// (event, attendee) pair — see Task 15's review for the duplicate-reminder bug this caused.
const icsWithSelfOrganizer = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:dup-organizer
SUMMARY:Team sync
DTSTART:20240615T150000Z
DTEND:20240615T160000Z
ORGANIZER;CN=Jane Doe:mailto:jane@example.com
ATTENDEE;CN=Jane Doe:mailto:jane@example.com
ATTENDEE;CN=Sam Lee:mailto:sam@example.com
END:VEVENT
END:VCALENDAR`;
const dupEvents = parseIcsEvents(icsWithSelfOrganizer);
if (dupEvents.length !== 1) throw new Error(`expected 1 event, got ${dupEvents.length}`);
const dedupedPeople = peopleFromEvent(dupEvents[0]);
if (dedupedPeople.length !== 2) {
  throw new Error(
    `expected 2 deduped people (Jane once, Sam once), got ${dedupedPeople.length}: ${JSON.stringify(dedupedPeople)}`
  );
}
if (!dedupedPeople.some((p) => p.email === "jane@example.com")) {
  throw new Error("Jane (organizer + attendee) should still appear once");
}
if (!dedupedPeople.some((p) => p.email === "sam@example.com")) {
  throw new Error("Sam (attendee only) should still appear");
}

// Same identity, resolved two different ways — one entry has only an email, the other only
// a name that happens to match nothing (a stand-in for "one attendee line is email-only, a
// separate one is name-only, and they really are the same person"). This dedupe key can only
// catch exact matches on its own resolved key, not cross-reference email against name, so two
// entries that only share an email dedupe correctly while a name-only + email-only pair for
// the *same* real person does not — documenting that limit here, not just asserting around it.
const sameEmailTwice = peopleFromEvent({
  uid: "dup-email",
  summary: "",
  description: "",
  location: "",
  start: null,
  end: null,
  attendees: [
    { name: "Jane Doe", email: "jane@example.com" },
    { name: "J. Doe", email: "jane@example.com" },
  ],
  organizer: null,
});
if (sameEmailTwice.length !== 1) {
  throw new Error(
    `expected 1 deduped person for two entries sharing an email, got ${sameEmailTwice.length}`
  );
}

console.log("parser smoke tests passed");
