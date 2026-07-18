import { parseLinkedInMessagesCsv, resolveConversations } from "../src/lib/linkedin-messages";
import { parseIcsEvents } from "../src/lib/calendar-import";
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

console.log("parser smoke tests passed");
