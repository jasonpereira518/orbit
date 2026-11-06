/**
 * Past meetings and the search over them, against PGlite: only finished meetings are listed,
 * newest first, paged with no repeats or gaps; a search matches title, summary, guests and
 * transcript (with the line that matched), treats `%` and `_` as characters rather than
 * wildcards, and never crosses users; Chat's passage search finds a person's meetings by
 * name and a topic by what was said.
 * Run: npx tsx scripts/smoke-meetings-list.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-meetings-list";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-meetings-list";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  contacts,
  interactions,
  meetingSessions,
  meetingTranscriptSegments,
  noteBatches,
  type MeetingDigest,
  type MeetingSessionStatus,
} from "../src/db/schema";
import {
  excerptAround,
  getGranolaMeeting,
  likePattern,
  listMeetingsFor,
  parseGranolaNote,
  searchMeetingPassagesFor,
  searchWords,
} from "../src/lib/meetings-list";
import { setMeetingUserNotes } from "../src/lib/meeting-sessions";

const USER = "smoke-meetings-list-user";
const OTHER = "smoke-meetings-list-other";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const DAY = 86_400_000;
const NOW = Date.now();

function digest(summary: string): MeetingDigest {
  return {
    title: "",
    summary,
    keyPoints: [],
    decisions: [],
    actionItems: [],
    blockers: [],
    openQuestions: [],
    participants: [],
    datedQuotes: [],
    notes: "",
  };
}

async function reset() {
  const db = await getDb();
  for (const user of [USER, OTHER]) {
    await db.delete(meetingTranscriptSegments).where(eq(meetingTranscriptSegments.userId, user));
    await db.delete(meetingSessions).where(eq(meetingSessions.userId, user));
    await db.delete(interactions).where(eq(interactions.userId, user));
    await db.delete(noteBatches).where(eq(noteBatches.userId, user));
    await db.delete(contacts).where(eq(contacts.userId, user));
  }
}

/** One Granola note as the sync saves it: a batch, and one interaction per person it named. */
async function seedGranola(
  userId: string,
  opts: { title: string; daysAgo: number; summary: string; people: string[]; myNotes?: string; at?: Date; status?: "saved" | "undone" }
) {
  const db = await getDb();
  const at = opts.at ?? new Date(NOW - opts.daysAgo * DAY);
  const sourceText = [
    `Meeting: ${opts.title}`,
    `When: ${at.toISOString()}`,
    `Attendees: ${opts.people.join(", ")}`,
    opts.summary,
    opts.myNotes ? `My notes:\n${opts.myNotes}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const people = [];
  for (const name of opts.people) {
    const [c] = await db.insert(contacts).values({ userId, fullName: name }).returning();
    people.push(c);
  }
  const [batch] = await db
    .insert(noteBatches)
    .values({
      userId,
      sourceHash: `smoke-${Math.random()}`,
      sourceText,
      anchorDate: at,
      status: opts.status ?? "saved",
      result: {
        participants: people.map((c) => ({ contactId: c.id, interactionId: null, name: c.fullName, created: true, duplicate: false })),
        mentions: [],
        unresolvedMentions: [],
        actionItems: [],
        reminders: [],
        skipped: { relative: 0, unverifiable: 0, past: 0, duplicate: 0 },
      },
    })
    .returning();
  for (const c of people) {
    await db.insert(interactions).values({
      userId,
      contactId: c.id,
      interactionType: "meeting",
      interactionDate: at,
      source: "granola",
      externalId: `granola:note-${batch.id}:${c.id}`,
      noteBatchId: batch.id,
    });
  }
  return batch.id;
}

async function seed(
  userId: string,
  opts: {
    title: string | null;
    status: MeetingSessionStatus;
    daysAgo: number;
    summary?: string;
    guests?: string[];
    lines?: string[];
    startedAt?: Date;
  }
) {
  const db = await getDb();
  const [row] = await db
    .insert(meetingSessions)
    .values({
      userId,
      title: opts.title,
      status: opts.status,
      startedAt: opts.startedAt ?? new Date(NOW - opts.daysAgo * DAY),
      attendees: (opts.guests ?? []).map((name) => ({ name })),
      digest: opts.summary ? digest(opts.summary) : null,
      durationMs: 600_000,
    })
    .returning();
  for (const [i, text] of (opts.lines ?? []).entries()) {
    await db.insert(meetingTranscriptSegments).values({
      sessionId: row.id,
      userId,
      seq: i,
      startMs: i * 60_000,
      endMs: i * 60_000 + 55_000,
      text,
      engine: "deepgram",
    });
  }
  return row.id;
}

function pure() {
  console.log("Pure helpers");
  check("a % in a search is a character, not a wildcard", likePattern("50%") === "%50\\%%");
  check("so is _ and a backslash", likePattern("a_b\\c") === "%a\\_b\\\\c%");
  check("filler is dropped from a question", searchWords("What did they say about pricing?").join() === "pricing");
  check("names and topics are kept, deduped, lower-cased", searchWords("Priya pricing PRIYA").join() === "priya,pricing");
  check("short words are dropped", searchWords("is it ok").length === 0);
  check("an excerpt centres on the match", excerptAround("a ".repeat(100) + "pricing is per seat " + "b ".repeat(100), "pricing", 20).includes("pricing"));
  const note = parseGranolaNote("Meeting: Acme kickoff\n\nWhen: 2026-11-01T15:00:00Z\n\nAttendees: Dana <d@x.co>\n\n## Summary\nScope agreed.\n\n- Ship v1\n\nMy notes:\nAsk about budget");
  check("a Granola note splits into title, body and my notes", note.title === "Acme kickoff" && note.body === "## Summary\nScope agreed.\n\n- Ship v1" && note.myNotes === "Ask about budget" && note.attendees === "Dana <d@x.co>");
  const bare = parseGranolaNote("Meeting: Quick sync\n\nWhen: 2026-11-01T15:00:00Z\n\nJust the summary.");
  check("…and one with no attendees or notes keeps the summary", bare.title === "Quick sync" && bare.body === "Just the summary." && bare.myNotes === null && bare.attendees === null);
}

async function main() {
  pure();
  await reset();

  const pilot = await seed(USER, {
    title: "Pilot sync",
    status: "analyzed",
    daysAgo: 3,
    summary: "We agreed pricing is per seat, not per workspace.",
    guests: ["Priya Raman"],
    lines: ["Thanks for joining everyone.", "I think pricing should be per seat from day one.", "Legal still has the agreement."],
  });
  const board = await seed(USER, {
    title: "Board prep",
    status: "saved",
    daysAgo: 1,
    summary: "Budget review ahead of the board.",
    guests: ["Marcus Lee"],
    lines: ["Marcus will chase legal by Friday."],
  });
  const unfinished = await seed(USER, { title: "Still going", status: "ended", daysAgo: 0, lines: ["pricing pricing pricing"] });
  const discarded = await seed(USER, { title: "Thrown away", status: "discarded", daysAgo: 2, lines: ["pricing"] });
  const theirs = await seed(OTHER, { title: "Not yours", status: "analyzed", daysAgo: 1, summary: "pricing", guests: ["Priya Raman"], lines: ["pricing per seat"] });

  console.log("\nThe list");
  const all = await listMeetingsFor(USER);
  check("only finished meetings, newest first", all.items.map((m) => m.id).join() === [board, pilot].join(), all.items.map((m) => m.title).join());
  check("nothing from another user", !all.items.some((m) => m.id === theirs));
  check("unfinished and discarded meetings are not history", !all.items.some((m) => m.id === unfinished || m.id === discarded));
  check("a row carries its guests, summary and status", all.items[1].attendees.join() === "Priya Raman" && /per seat/.test(all.items[1].summary ?? "") && all.items[0].status === "saved");
  check("no search means no match line", all.items.every((m) => m.match === null));

  console.log("\nPaging");
  // Several meetings in the same millisecond: the cursor has to carry Postgres's own text.
  const same = new Date(NOW - 10 * DAY);
  const sameIds = [
    await seed(USER, { title: "Twin A", status: "analyzed", daysAgo: 10, startedAt: same }),
    await seed(USER, { title: "Twin B", status: "analyzed", daysAgo: 10, startedAt: same }),
    await seed(USER, { title: "Twin C", status: "analyzed", daysAgo: 10, startedAt: same }),
  ];
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await listMeetingsFor(USER, { limit: 2, cursor });
    seen.push(...page.items.map((m) => m.id));
    cursor = page.nextCursor;
    pages++;
  } while (cursor && pages < 10);
  check("every finished meeting appears once across pages", seen.length === 5 && new Set(seen).size === 5, String(seen.length));
  check("including the ones that share a start time", sameIds.every((id) => seen.includes(id)));
  check("a junk cursor falls back to the first page", (await listMeetingsFor(USER, { cursor: "garbage|nope" })).items.length === 5);

  console.log("\nSearch");
  const byTopic = await listMeetingsFor(USER, { q: "pricing" });
  check("matches the transcript and the summary", byTopic.items.length === 1 && byTopic.items[0].id === pilot);
  check("and says which line", byTopic.items[0].match?.startMs === 60_000 && /per seat/.test(byTopic.items[0].match?.excerpt ?? ""));
  check("matches a guest's name", (await listMeetingsFor(USER, { q: "priya" })).items[0]?.id === pilot);
  check("matches a title", (await listMeetingsFor(USER, { q: "board" })).items[0]?.id === board);
  check("case does not matter", (await listMeetingsFor(USER, { q: "MARCUS" })).items[0]?.id === board);
  check("a % is not a wildcard", (await listMeetingsFor(USER, { q: "%" })).items.length === 0);
  check("a search never crosses users", !(await listMeetingsFor(USER, { q: "pricing" })).items.some((m) => m.id === theirs));
  check("their search finds theirs", (await listMeetingsFor(OTHER, { q: "pricing" })).items[0]?.id === theirs);
  check("an unfinished meeting's words are not searchable history", (await listMeetingsFor(USER, { q: "pricing pricing pricing" })).items.length === 0);

  console.log("\nChat passages");
  const passages = await searchMeetingPassagesFor(USER, { query: "What did Priya say about pricing?" });
  check("finds the line that was said", passages.some((p) => p.kind === "transcript" && p.meetingId === pilot && /per seat/.test(p.snippet)));
  check("and the meeting's summary, since Priya was on it", passages.some((p) => p.kind === "summary" && p.meetingId === pilot));
  check("the best match comes first", passages[0].meetingId === pilot);
  check("never another user's meeting", !passages.some((p) => p.meetingId === theirs));
  check("never an unfinished or discarded one", !passages.some((p) => p.meetingId === unfinished || p.meetingId === discarded));
  check("a transcript passage says when, a summary does not", passages.find((p) => p.kind === "transcript")!.startMs !== null && passages.find((p) => p.kind === "summary")!.startMs === null);
  check("a person's name alone finds their meetings", (await searchMeetingPassagesFor(USER, { query: "Marcus" })).some((p) => p.meetingId === board));
  const early = await searchMeetingPassagesFor(USER, { query: "pricing", before: new Date(NOW - 2 * DAY) });
  const late = await searchMeetingPassagesFor(USER, { query: "legal", after: new Date(NOW - 2 * DAY) });
  check("a date window narrows it", early.length > 0 && early.every((p) => p.meetingId === pilot) && late.length > 0 && late.every((p) => p.meetingId === board));
  check("a question of only filler finds nothing", (await searchMeetingPassagesFor(USER, { query: "what did they say" })).length === 0);

  console.log("\nYour notes");
  check("notes save to your own meeting", await setMeetingUserNotes(USER, pilot, "Follow up on the procurement form"));
  check("never to someone else's", !(await setMeetingUserNotes(USER, theirs, "hijack")));
  check("a non-id is refused, not queried", !(await setMeetingUserNotes(USER, "nope", "x")));
  check("a search finds words only in your notes", (await listMeetingsFor(USER, { q: "procurement" })).items[0]?.id === pilot);
  const theirRow = (await getDb()).select().from(meetingSessions).where(eq(meetingSessions.id, theirs));
  check("their notes were not touched", (await theirRow)[0]?.userNotes === null);

  console.log("\nGranola alongside recordings");
  // Between the two recordings (board 1 day ago, pilot 3), and one sharing the twins' instant.
  const acme = await seedGranola(USER, { title: "Acme kickoff", daysAgo: 2, summary: "Scope agreed; Dana owns the rollout.", people: ["Dana Cole", "Eli Park"], myNotes: "Ask about budget" });
  const granolaTwin = await seedGranola(USER, { title: "Twin Granola", daysAgo: 10, summary: "Same instant as the twins.", people: ["Fay Hu"], at: same });
  const undone = await seedGranola(USER, { title: "Undone note", daysAgo: 4, summary: "Was undone.", people: ["Gus Ray"], status: "undone" });
  const theirGranola = await seedGranola(OTHER, { title: "Their Granola", daysAgo: 2, summary: "Not yours.", people: ["Hal Ito"] });

  const mixed = await listMeetingsFor(USER);
  check("Granola rows interleave by date", mixed.items.slice(0, 3).map((m) => m.id).join() === [board, acme, pilot].join(), mixed.items.map((m) => m.title).join());
  const acmeRow = mixed.items.find((m) => m.id === acme);
  check("a Granola row is labelled, titled and lists its people", acmeRow?.source === "granola" && acmeRow.title === "Acme kickoff" && acmeRow.attendees.join() === "Dana Cole,Eli Park");
  check("one row per note, not per person", mixed.items.filter((m) => m.id === acme).length === 1);
  check("its summary is Granola's text, not the header lines", acmeRow?.summary === "Scope agreed; Dana owns the rollout.");
  check("an undone batch is not listed", !mixed.items.some((m) => m.id === undone));
  check("another user's Granola never shows", !mixed.items.some((m) => m.id === theirGranola));

  const mixedSeen: string[] = [];
  cursor = null;
  pages = 0;
  do {
    const page = await listMeetingsFor(USER, { limit: 2, cursor });
    mixedSeen.push(...page.items.map((m) => m.id));
    cursor = page.nextCursor;
    pages++;
  } while (cursor && pages < 10);
  check("paging crosses both sources with no repeats or gaps", mixedSeen.length === 7 && new Set(mixedSeen).size === 7, String(mixedSeen.length));
  check("including a Granola note at the same instant as recordings", mixedSeen.includes(granolaTwin) && sameIds.every((id) => mixedSeen.includes(id)));

  check("the Recorded filter leaves Granola out", (await listMeetingsFor(USER, { source: "orbit" })).items.every((m) => m.source === "orbit"));
  const onlyGranola = await listMeetingsFor(USER, { source: "granola" });
  check("the Granola filter leaves recordings out", onlyGranola.items.map((m) => m.id).join() === [acme, granolaTwin].join());
  const rollout = await listMeetingsFor(USER, { q: "rollout" });
  check("search reaches Granola's text, with the line that matched", rollout.items.length === 1 && rollout.items[0].id === acme && /rollout/i.test(rollout.items[0].match?.excerpt ?? ""));
  check("…and its notes too", (await listMeetingsFor(USER, { q: "ask about budget" })).items.map((m) => m.id).join() === acme);
  check("a Granola search never crosses users", !(await listMeetingsFor(USER, { q: "Not yours" })).items.length);

  const detail = await getGranolaMeeting(USER, acme);
  check("the detail read parses the note", detail?.note.title === "Acme kickoff" && detail.note.myNotes === "Ask about budget");
  check("the detail read is scoped to its owner", (await getGranolaMeeting(OTHER, acme)) === null && (await getGranolaMeeting(USER, theirGranola)) === null);
  check("a recording's id is not a Granola meeting", (await getGranolaMeeting(USER, pilot)) === null);
  check("an undone batch has no detail page", (await getGranolaMeeting(USER, undone)) === null);

  await reset();
  console.log("\nsmoke-meetings-list: all checks passed");
}

run(main);
