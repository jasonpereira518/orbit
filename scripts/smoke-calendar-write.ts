/**
 * Chat meetings on the person's own calendar (`src/lib/calendar-write.ts` and `create_meeting`
 * in `src/lib/tools/chat-writes.ts`).
 *
 * No connection → nothing to write; a read-only calendar → the card asks for the grant and the
 * meeting stays in Orbit; with `calendar.events` → one POST to the primary calendar with
 * `sendUpdates=none` and no attendees, the event stored in `calendar_events`, the reminder
 * linked by `calendar_event_key`, and Undo removing both. A provider refusal never fails the
 * meeting. Outlook goes to Graph in UTC. The adding of an Orbit-only meeting later links it.
 *
 * PGlite, demo mode, `fetch` faked. Run: npx tsx scripts/smoke-calendar-write.ts
 */
import "./smoke/_env";
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { calendarEvents, calendarSources, gmailConnections, outlookConnections, reminders } from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { addReminderMeetingToCalendar, calendarWriteState } from "../src/lib/calendar-write";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import { MICROSOFT_SCOPES } from "../src/lib/microsoft-scopes";
import { chatWriteNamed, runUndo, type UndoStep } from "../src/lib/tools/chat-writes";

const USER = "smoke-calendar-write";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

type Call = { url: string; method: string; body: Record<string, unknown> | null };
const calls: Call[] = [];
let failNext = false;
let seq = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
  calls.push({ url, method, body });
  if (failNext) {
    failNext = false;
    return new Response("nope", { status: 500 });
  }
  if (method === "DELETE") return new Response(null, { status: 204 });
  const id = `evt${++seq}`;
  if (url.includes("googleapis.com")) {
    return Response.json({ id, status: "confirmed", summary: body?.summary, start: body?.start, end: body?.end, location: body?.location });
  }
  return Response.json({ id, subject: body?.subject, start: body?.start, end: body?.end });
}) as typeof fetch;

async function clear() {
  const db = await getDb();
  await db.delete(calendarEvents).where(eq(calendarEvents.userId, USER));
  await db.delete(calendarSources).where(eq(calendarSources.userId, USER));
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(gmailConnections).where(eq(gmailConnections.userId, USER));
  await db.delete(outlookConnections).where(eq(outlookConnections.userId, USER));
}

const connection = (scopes: string) => ({
  userId: USER,
  emailAddress: "me@acme-corp.io",
  accessTokenEncrypted: encrypt("t"),
  refreshTokenEncrypted: encrypt("r"),
  tokenExpiresAt: new Date(Date.now() + 3_600_000),
  scopes,
  status: "active" as const,
});

async function main() {
  await clear();
  const db = await getDb();
  const write = chatWriteNamed("create_meeting")!;
  const startsAt = new Date(Date.now() + 2 * 86_400_000);
  startsAt.setUTCHours(19, 0, 1, 0);
  const input = { title: "Coffee with Maya", starts_at: startsAt.toISOString(), duration_min: 45, location: "Blue Bottle" };
  const commit = () => write.commit(USER, input, { messageId: "m", actionId: crypto.randomUUID() });
  const reminderOf = (id: string | null) => db.query.reminders.findFirst({ where: eq(reminders.id, id ?? "") });

  console.log("No connection");
  {
    check("nothing may write", (await calendarWriteState(USER)).kind === "none");
    const out = await commit();
    check("the meeting is still made, in Orbit only", out.undo?.input.onCalendar === false && calls.length === 0);
  }

  console.log("\nGoogle, read only");
  await db.insert(gmailConnections).values(connection(`${GOOGLE_SCOPES.email} ${GOOGLE_SCOPES.calendar}`));
  let orbitOnly: string | null = null;
  {
    const state = await calendarWriteState(USER);
    check("the card asks Google for the grant", state.kind === "grant" && state.provider === "google");
    const out = await commit();
    orbitOnly = out.resultId;
    check("no event is written without it", calls.length === 0 && out.undo?.input.onCalendar === false);
  }

  console.log("\nGoogle, events granted");
  await db
    .update(gmailConnections)
    .set({ scopes: `${GOOGLE_SCOPES.email} ${GOOGLE_SCOPES.calendar} ${GOOGLE_SCOPES.calendarWrite}` })
    .where(eq(gmailConnections.userId, USER));
  let undo: UndoStep | null = null;
  let eventId = "";
  {
    check("ready to write", (await calendarWriteState(USER)).kind === "ready");
    const out = await commit();
    const post = calls.at(-1)!;
    check(
      "one POST to the primary calendar, nobody told",
      calls.length === 1 && post.method === "POST" && post.url.includes("/calendars/primary/events?sendUpdates=none")
    );
    check("no attendees are sent", post.body !== null && !("attendees" in post.body));
    check(
      "the time and length are the meeting's",
      (post.body?.start as { dateTime?: string })?.dateTime === startsAt.toISOString() &&
        (post.body?.end as { dateTime?: string })?.dateTime === new Date(startsAt.getTime() + 45 * 60_000).toISOString()
    );
    const row = await reminderOf(out.resultId);
    eventId = row?.calendarEventKey ?? "";
    check("the reminder is linked to the event", eventId === "evt1" && out.undo?.input.onCalendar === true);
    const stored = await db.query.calendarEvents.findFirst({ where: and(eq(calendarEvents.userId, USER), eq(calendarEvents.providerEventId, eventId)) });
    check("the event is in calendar_events now, not at the next sync", stored?.title === "Coffee with Maya" && stored.location === "Blue Bottle");
    undo = out.undo;
  }

  console.log("\nUndo");
  {
    await runUndo(USER, undo!);
    const del = calls.at(-1)!;
    check("the event is deleted at Google, quietly", del.method === "DELETE" && del.url.endsWith(`/events/${eventId}?sendUpdates=none`));
    const stored = await db.query.calendarEvents.findFirst({ where: eq(calendarEvents.providerEventId, eventId) });
    const row = await db.query.reminders.findFirst({ where: eq(reminders.calendarEventKey, eventId) });
    check("…and gone from calendar_events, and the reminder dismissed", !stored && row?.status === "dismissed");
  }

  console.log("\nA refusal");
  {
    failNext = true;
    const out = await commit();
    check("the meeting is made anyway, in Orbit", Boolean(out.resultId) && out.undo?.input.onCalendar === false);
  }

  console.log("\nAdding an Orbit-only meeting later");
  {
    const added = await addReminderMeetingToCalendar(USER, orbitOnly!);
    const row = await reminderOf(orbitOnly);
    check("it goes on the calendar and is linked", added?.provider === "google" && row?.calendarEventKey === added.eventId);
    let threw = false;
    try {
      await addReminderMeetingToCalendar(USER, orbitOnly!);
    } catch {
      threw = true;
    }
    check("…once", threw);
  }

  console.log("\nOutlook");
  await db.delete(gmailConnections).where(eq(gmailConnections.userId, USER));
  await db.insert(outlookConnections).values(connection(`${MICROSOFT_SCOPES.calendar} ${MICROSOFT_SCOPES.calendarWrite}`));
  {
    const before = calls.length;
    const out = await commit();
    const post = calls[before]!;
    check("one POST to Graph's events", post?.method === "POST" && post.url === "https://graph.microsoft.com/v1.0/me/events");
    check(
      "in UTC, with no attendees",
      (post.body?.start as { timeZone?: string })?.timeZone === "UTC" && !("attendees" in (post.body ?? {}))
    );
    check("linked", out.undo?.input.onCalendar === true);
    await runUndo(USER, out.undo!);
    check("Undo deletes it from Graph", calls.at(-1)?.method === "DELETE" && calls.at(-1)!.url.startsWith("https://graph.microsoft.com/v1.0/me/events/"));
  }

  await clear();
  if (failures) {
    console.error(`\n${failures} calendar-write check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll calendar-write checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
