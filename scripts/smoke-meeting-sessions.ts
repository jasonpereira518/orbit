/**
 * Meeting capture's server half against a real (throwaway) database, with transcription
 * stubbed: chunks are idempotent by seq and assemble in order whatever order they arrive,
 * only the live recorder may write, a saved meeting stores its summary on the note batch
 * and turns ticked items into reminders exactly once, and discard leaves nothing behind.
 * Run: npx tsx scripts/smoke-meeting-sessions.ts
 */
import "./smoke/_env";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-meeting-sessions";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-meeting-sessions";

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  contacts,
  meetingSessions,
  meetingTranscriptSegments,
  noteBatches,
  reminders,
  userSettings,
  type MeetingDigest,
} from "../src/db/schema";
import type { TranscribeOptions } from "../src/lib/ai";
import {
  assembleTranscriptText,
  createMeetingSessionRow,
  discardMeetingSessionRow,
  endMeetingSessionRow,
  getMeetingTranscript,
  getResumableMeeting,
  ingestMeetingChunk,
  markMeetingSessionSaved,
  missingSeqs,
  resumeMeetingSessionRow,
  storeMeetingDigest,
  toNoteBatchMeeting,
  type Transcriber,
} from "../src/lib/meeting-sessions";
import { saveNoteBatch, undoNoteBatchForUser, type SaveNoteBatchInput } from "../src/lib/note-batch-save";
import { hashSourceNote } from "../src/lib/suggested-reminder-utils";
import { ensureUserSettings } from "../src/lib/user-settings";
import { encodeWav16 } from "../src/lib/voice-recording";

const USER = "smoke-meeting-sessions-user";
const OTHER = "smoke-meeting-sessions-other";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  for (const user of [USER, OTHER]) {
    await db.delete(meetingTranscriptSegments).where(eq(meetingTranscriptSegments.userId, user));
    await db.delete(meetingSessions).where(eq(meetingSessions.userId, user));
    await db.delete(reminders).where(eq(reminders.userId, user));
    await db.delete(noteBatches).where(eq(noteBatches.userId, user));
    await db.delete(contacts).where(eq(contacts.userId, user));
    await db.delete(userSettings).where(eq(userSettings.userId, user));
    await ensureUserSettings(user);
  }
}

/** A stub transcriber that records every call and returns a line per chunk. */
function stubTranscriber() {
  const calls: { filename?: string; opts?: TranscribeOptions; bytes: number }[] = [];
  const fn: Transcriber = async (_userId, input, opts) => {
    calls.push({ filename: input.filename, opts, bytes: Buffer.from(input.base64, "base64").length });
    const seq = Number(input.filename?.match(/meeting-(\d+)/)?.[1] ?? -1);
    return { text: `line ${seq}`, engine: "whisper" };
  };
  return { fn, calls };
}

const WAV = encodeWav16(new Int16Array(16_000)); // one second of silence, as real WAV bytes
const meta = (seq: number, recorderId: string | null) => ({
  seq,
  startMs: seq * 60_000,
  endMs: (seq + 1) * 60_000,
  recorderId,
});

const DIGEST: MeetingDigest = {
  title: "Pilot review",
  summary: "We reviewed the pilot and agreed next steps.",
  keyPoints: ["Pilot is live with three customers"],
  decisions: ["Price per workspace"],
  actionItems: [
    { text: "Send Priya the deck", owner: "me", duePhrase: null, sourceExcerpt: null },
    { text: "Chase legal", owner: "Marcus Lee", duePhrase: "by Friday", sourceExcerpt: null },
  ],
  blockers: [{ text: "Legal sign-off from Acme's counsel", owner: null, sourceExcerpt: null }],
  openQuestions: [{ text: "Seat or workspace pricing for the enterprise tier?", askedBy: "Priya Raman", sourceExcerpt: null }],
  participants: [{ name: "Priya Raman", present: true, context: "Runs the pilot" }],
  datedQuotes: [],
  notes: "Met with Priya about the pilot.",
};

async function main() {
  await reset();
  const db = await getDb();

  // ── Sessions ────────────────────────────────────────────────────────────────────────
  const first = await createMeetingSessionRow(USER, {
    title: "  Pilot   review  ",
    attendees: [{ name: "Priya Raman" }, { name: "priya raman" }, { name: " " }],
    includesMic: true,
    captureSurface: "browser",
    recorderId: "rec-A",
  });
  check("a session starts recording", first.status === "recording" && first.recorderId === "rec-A");
  check("…with a cleaned title", first.title === "Pilot review");
  check("…and deduplicated attendees", first.attendees.length === 1 && first.attendees[0]!.name === "Priya Raman");

  const second = await createMeetingSessionRow(USER, { includesMic: false, recorderId: "rec-B" });
  const firstAfter = await db.query.meetingSessions.findFirst({ where: eq(meetingSessions.id, first.id) });
  check("starting a new meeting ends the one still marked recording", firstAfter?.status === "ended" && firstAfter.recorderId === null);
  await discardMeetingSessionRow(USER, second.id);

  // ── Chunks ──────────────────────────────────────────────────────────────────────────
  // Resume the first so rec-C owns it, then send chunks out of order.
  const resumed = await resumeMeetingSessionRow(USER, first.id, "rec-C");
  check("resume hands the session to a new recorder", resumed.ok && resumed.session.recorderId === "rec-C" && resumed.session.status === "recording");

  const t = stubTranscriber();
  const c1 = await ingestMeetingChunk(USER, first.id, meta(1, "rec-C"), WAV, t.fn);
  check("a chunk is transcribed and stored", c1.ok && c1.text === "line 1" && !c1.duplicate);
  check("…as WAV bytes, base64'd for the engine", t.calls[0]?.bytes === WAV.byteLength);
  check("…with no context when nothing came before", t.calls[0]?.opts?.contextText == null);
  check("…counted under its own usage operation", t.calls[0]?.opts?.operation === "meeting.transcribe" && t.calls[0]?.opts?.allowEmpty === true);

  const c0 = await ingestMeetingChunk(USER, first.id, meta(0, "rec-C"), WAV, t.fn);
  check("an earlier seq arriving late is stored", c0.ok && c0.text === "line 0");

  const c2 = await ingestMeetingChunk(USER, first.id, meta(2, "rec-C"), WAV, t.fn);
  check("the previous chunk's text is sent as context", c2.ok && t.calls.at(-1)?.opts?.contextText === "line 1");

  const callsBefore = t.calls.length;
  const again = await ingestMeetingChunk(USER, first.id, meta(0, "rec-C"), WAV, t.fn);
  check("a repeated seq is acknowledged as a duplicate", again.ok && again.duplicate && again.text === "line 0");
  check("…without transcribing it twice", t.calls.length === callsBefore);

  const silent = await ingestMeetingChunk(USER, first.id, meta(3, "rec-C"), null, t.fn);
  check("a silent chunk is stored as silence", silent.ok && silent.engine === "silent" && silent.text === "");
  check("…at no transcription cost", t.calls.length === callsBefore);

  const hijack = await ingestMeetingChunk(USER, first.id, meta(4, "rec-OLD"), WAV, t.fn);
  check("another recorder is refused while this one records", !hijack.ok && hijack.status === 409);

  const stranger = await ingestMeetingChunk(OTHER, first.id, meta(4, "rec-C"), WAV, t.fn);
  check("another user's meeting is not found", !stranger.ok && stranger.status === 404);

  const badId = await ingestMeetingChunk(USER, "not-a-uuid", meta(0, "rec-C"), WAV, t.fn);
  check("a malformed id is a 404, not a database error", !badId.ok && badId.status === 404);

  const badMeta = await ingestMeetingChunk(USER, first.id, { seq: -1, startMs: 0, endMs: 1, recorderId: "rec-C" }, WAV, t.fn);
  check("a bad seq is refused", !badMeta.ok && badMeta.status === 400);

  await endMeetingSessionRow(USER, first.id, { durationMs: 250_000 });
  const late = await ingestMeetingChunk(USER, first.id, meta(5, "rec-anyone"), WAV, t.fn);
  check("after Stop, an outbox straggler from any tab is accepted", late.ok && late.text === "line 5");

  const transcript = (await getMeetingTranscript(USER, first.id))!;
  check("segments come back in seq order", transcript.segments.map((s) => s.seq).join() === "0,1,2,3,5");
  check("the text skips silence and keeps order", transcript.text === "line 0\n\nline 1\n\nline 2\n\nline 5");
  check("a seq that never arrived is reported missing", transcript.missingSeqs.join() === "4");
  check("lastSeq tracks the highest stored", transcript.session.lastSeq === 5);
  check("duration tracks the furthest chunk end", transcript.session.durationMs === 360_000);

  check("assembleTranscriptText sorts whatever it is given", assembleTranscriptText([{ seq: 2, text: "c" }, { seq: 0, text: "a" }, { seq: 1, text: " " }]) === "a\n\nc");
  check("missingSeqs on a dense run is empty", missingSeqs([0, 1, 2], 2).length === 0);

  const resumable = await getResumableMeeting(USER);
  check("the unfinished meeting is offered for resuming", resumable?.id === first.id && resumable.segmentCount === 5 && resumable.lastSeq === 5);

  // ── Analysis stored ─────────────────────────────────────────────────────────────────
  await storeMeetingDigest(USER, first.id, { digest: DIGEST });
  const analyzed = await db.query.meetingSessions.findFirst({ where: eq(meetingSessions.id, first.id) });
  check("a stored digest marks the meeting analyzed", analyzed?.status === "analyzed" && analyzed.digest?.title === "Pilot review");
  const summary = toNoteBatchMeeting(analyzed!);
  check("the results snapshot keeps the session's own title", summary.title === "Pilot review" && summary.sessionId === first.id);

  // ── Save: a meeting with no people and no dates is still a save ─────────────────────
  const corpus = "Video call — Pilot review. These are my notes.";
  const saveInput: SaveNoteBatchInput = {
    sourceText: corpus,
    sourceHash: hashSourceNote(corpus),
    anchorIso: "2026-09-11",
    anchorBasis: "hint",
    entryPoint: "capture",
    participants: [],
    commitments: [],
    skipped: { relative: 0, unverifiable: 0, past: 0 },
    meeting: {
      summary,
      extraReminders: [
        { kind: "action", title: "Send Priya the deck", ownerName: null, sourceExcerpt: null },
        { kind: "blocker", title: "Legal sign-off from Acme's counsel", ownerName: null, sourceExcerpt: "waiting on counsel" },
        { kind: "question", title: "Seat or workspace pricing for the enterprise tier?", ownerName: "Priya Raman", sourceExcerpt: null },
        { kind: "action", title: "   ", ownerName: null, sourceExcerpt: null },
      ],
    },
  };
  const saved = await saveNoteBatch(USER, saveInput);
  check("a meeting-only batch saves", Boolean(saved.batchId) && saved.created === 0);
  check("…with the meeting on the result", saved.result.meeting?.sessionId === first.id && saved.result.meeting.decisions[0] === "Price per workspace");
  const batchRow = await db.query.noteBatches.findFirst({ where: eq(noteBatches.id, saved.batchId) });
  check("…persisted on the batch row", batchRow?.result.meeting?.title === "Pilot review");

  const rems = await db.query.reminders.findMany({ where: and(eq(reminders.userId, USER), eq(reminders.noteBatchId, saved.batchId)) });
  const titles = rems.map((r) => r.title).sort();
  check("each ticked item became one reminder (blank titles skipped)", rems.length === 3, titles.join(" | "));
  check("blockers read as something to unblock", titles.includes("Unblock: Legal sign-off from Acme's counsel"));
  check("questions read as something to answer", titles.includes("Answer: Seat or workspace pricing for the enterprise tier?"));
  check("they carry the meeting's name", rems.every((r) => r.description === 'From the meeting "Pilot review"'));
  check("…and are due on the follow-up window", rems.every((r) => r.dateBasis === "window" && r.reminderType === "ai_suggested"));
  check("an owner not in the batch leaves the reminder unassigned", rems.every((r) => r.contactId === null));

  const resaved = await saveNoteBatch(USER, saveInput);
  const after = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
  check("saving the same meeting again creates no duplicate reminders", resaved.remindersCreated === 0 && after.length === 3, String(after.length));

  await markMeetingSessionSaved(USER, first.id, saved.batchId);
  const savedSession = await db.query.meetingSessions.findFirst({ where: eq(meetingSessions.id, first.id) });
  check("the session records its batch", savedSession?.status === "saved" && savedSession.noteBatchId === saved.batchId);
  const afterSave = await ingestMeetingChunk(USER, first.id, meta(6, null), WAV, t.fn);
  check("a new chunk for a saved meeting is refused", !afterSave.ok && afterSave.status === 410);
  const ackAfterSave = await ingestMeetingChunk(USER, first.id, meta(5, null), WAV, t.fn);
  check("…but a stored one is still acknowledged, so the outbox can clear", ackAfterSave.ok && ackAfterSave.duplicate);
  check("a saved meeting is not offered for resuming", (await getResumableMeeting(USER)) === null);

  const undone = await undoNoteBatchForUser(USER, saved.batchId);
  check("undo dismisses the meeting's reminders", undone.remindersDismissed === 3, String(undone.remindersDismissed));

  // ── Save with a participant: digest items that repeat a card's action item are skipped ─
  {
    const other = await createMeetingSessionRow(USER, { includesMic: true, recorderId: "rec-D" });
    await storeMeetingDigest(USER, other.id, { digest: DIGEST });
    const row = await db.query.meetingSessions.findFirst({ where: eq(meetingSessions.id, other.id) });
    const text = "Second meeting notes with Marcus.";
    const out = await saveNoteBatch(USER, {
      sourceText: text,
      sourceHash: hashSourceNote(text),
      anchorIso: "2026-09-11",
      anchorBasis: "hint",
      entryPoint: "capture",
      participants: [
        {
          notes: text,
          parsed: {
            name: "Marcus Lee", company: null, role: null, presence: "participant", location: null, email: null,
            linkedin_url: null, met_at: null, topics: [], action_items: ["Chase legal"], follow_up_recommendation: null,
            follow_up_days: null, relationship_score_suggestion: 2, tags: [], summary: null, key_facts: [],
            opportunities: [], shared_interests: [], suggested_next_message: null, confidence: 0.9,
            interaction_date: null, low_confidence_fields: [],
          },
          createReminder: false,
          relationshipScore: 2,
          tagNames: [],
          interactionType: "call",
        },
      ],
      commitments: [],
      skipped: { relative: 0, unverifiable: 0, past: 0 },
      meeting: {
        summary: toNoteBatchMeeting(row!),
        extraReminders: [
          { kind: "action", title: "Chase legal", ownerName: "Marcus Lee", sourceExcerpt: null },
          { kind: "blocker", title: "Waiting on the security review", ownerName: "Marcus Lee", sourceExcerpt: null },
        ],
      },
    });
    const r = await db.query.reminders.findMany({ where: and(eq(reminders.userId, USER), eq(reminders.noteBatchId, out.batchId)) });
    const chase = r.filter((x) => x.title.toLowerCase().includes("chase legal"));
    check("a digest item repeating a person's action item is not doubled", chase.length === 1, r.map((x) => x.title).join(" | "));
    const unblock = r.find((x) => x.title.startsWith("Unblock:"));
    check("an owner who is in the batch gets the reminder", Boolean(unblock) && unblock!.contactId === out.contactIds[0]);
    await discardMeetingSessionRow(USER, other.id);
  }

  // ── Discard ────────────────────────────────────────────────────────────────────────
  {
    const doomed = await createMeetingSessionRow(USER, { includesMic: true, recorderId: "rec-E" });
    await ingestMeetingChunk(USER, doomed.id, meta(0, "rec-E"), WAV, stubTranscriber().fn);
    check("another user cannot discard it", !(await discardMeetingSessionRow(OTHER, doomed.id)));
    check("the owner can", await discardMeetingSessionRow(USER, doomed.id));
    const s = await db.query.meetingSessions.findFirst({ where: eq(meetingSessions.id, doomed.id) });
    const segs = await db.query.meetingTranscriptSegments.findMany({ where: eq(meetingTranscriptSegments.sessionId, doomed.id) });
    check("discard deletes the session and every line of it", !s && segs.length === 0);
  }

  await reset();
  console.log("\nsmoke-meeting-sessions: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
