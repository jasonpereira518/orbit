/**
 * The extension's "Log at an event" from LinkedIn's Connections page: the ticked connections
 * land on one of the user's events (a guest already listed stays one row), their ids come back
 * for the debrief link, and nobody becomes a contact.
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-extension-log-connections.ts
 */
import "./smoke/_env";

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, eventAttendees, events, userSettings } from "../src/db/schema";
import { isPaywallError } from "../src/lib/entitlements";
import { logConnectionsRequestSchema } from "../src/lib/extension/contract.schema";
import { ExtensionRouteError } from "../src/lib/extension/http";
import { logConnectionsAtEvent, recentEventsForExtension } from "../src/lib/extension/log-connections";
import { createEventForUser, listRosterForUser, upsertEventAttendees } from "../src/lib/events/store";
import { parseRosterText } from "../src/lib/events/parse-roster";
import { setSurfaceComingSoon } from "../src/lib/surface-visibility";

const USER = "smoke-log-connections-user";
const OTHER = "smoke-log-connections-other";
const ADMIN = "smoke-log-connections-admin";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function refusal(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof ExtensionRouteError ? error.code : `unexpected: ${String(error)}`;
  }
}

const ana = { name: "Ana Founder", profileUrl: "https://www.linkedin.com/in/ana-founder/?miniProfileUrn=x", subtitle: "CTO at Tidal" };
const lee = { name: "Lee Builder", profileUrl: "https://linkedin.com/in/lee-builder" };

async function main() {
  const db = await getDb();
  for (const u of [USER, OTHER]) {
    await db.delete(eventAttendees).where(eq(eventAttendees.userId, u));
    await db.delete(events).where(eq(events.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
    await db.delete(userSettings).where(eq(userSettings.userId, u));
    await db.insert(userSettings).values({ userId: u });
  }

  const now = new Date("2026-10-25T15:00:00Z");
  const mixer = await createEventForUser(USER, { title: "Founders Mixer", startsAt: new Date("2026-10-24T23:00:00Z") });
  await createEventForUser(USER, { title: "Under way", startsAt: new Date("2026-10-25T14:00:00Z"), endsAt: new Date("2026-10-25T20:00:00Z") });
  await createEventForUser(USER, { title: "Next week", startsAt: new Date("2026-11-01T18:00:00Z") });
  // Ana was on the Luma guest list already, by name only.
  await upsertEventAttendees(USER, mixer.id, parseRosterText("Ana Founder").attendees, "paste");

  // --- the wire schema --------------------------------------------------------------------
  check("a request passes the schema", logConnectionsRequestSchema.safeParse({ eventId: mixer.id, people: [ana, lee] }).success);
  check("nobody ticked is refused", !logConnectionsRequestSchema.safeParse({ eventId: mixer.id, people: [] }).success);
  check(
    "more than the debrief's 25 is refused",
    !logConnectionsRequestSchema.safeParse({ eventId: mixer.id, people: Array.from({ length: 26 }, () => lee) }).success
  );
  check("an event id that is not a uuid is refused", !logConnectionsRequestSchema.safeParse({ eventId: "x", people: [lee] }).success);

  // --- the gates ---------------------------------------------------------------------------
  await setSurfaceComingSoon(ADMIN, "page.events", true);
  check("while Events is coming soon → not_found", (await refusal(() => recentEventsForExtension(USER, now))) === "not_found");
  await setSurfaceComingSoon(ADMIN, "page.events", false);
  // Whatever the plan rule says: on a plan without Events the request is refused, never served.
  let gate: unknown = null;
  try {
    await recentEventsForExtension(USER, now);
  } catch (error) {
    gate = error;
  }
  check("the plan rule is enforced (served, or a paywall refusal)", gate === null || isPaywallError(gate), String(gate));
  for (const u of [USER, OTHER]) await db.update(userSettings).set({ compedPlan: "orbit" }).where(eq(userSettings.userId, u));

  // --- the event picker --------------------------------------------------------------------
  const recent = await recentEventsForExtension(USER, now);
  const titles = recent.events.map((e) => e.title);
  check("an event under way is offered first", titles[0] === "Under way", titles.join(","));
  check("a past event is offered", titles.includes("Founders Mixer"), titles.join(","));
  check("one that has not started is not", !titles.includes("Next week"), titles.join(","));

  // --- refusals ----------------------------------------------------------------------------
  const theirs = await createEventForUser(OTHER, { title: "Not yours" });
  check("another user's event → not_found", (await refusal(() => logConnectionsAtEvent(USER, { eventId: theirs.id, people: [lee] }))) === "not_found");
  check(
    "no LinkedIn profile link → invalid_request",
    (await refusal(() => logConnectionsAtEvent(USER, { eventId: mixer.id, people: [{ name: "No Link" }] }))) === "invalid_request"
  );

  // --- the save ----------------------------------------------------------------------------
  const first = await logConnectionsAtEvent(USER, { eventId: mixer.id, people: [ana, lee, { ...lee }] });
  let roster = await listRosterForUser(USER, mixer.id);
  check("two people come back", first.attendeeIds.length === 2, JSON.stringify(first));
  check("only Lee was new", first.added === 1, JSON.stringify(first));
  check("Ana stays one row", roster.filter((r) => r.fullName === "Ana Founder").length === 1, `${roster.length} rows`);
  const leeRow = roster.find((r) => r.fullName === "Lee Builder");
  check("Lee is on the event with a canonical LinkedIn URL", leeRow?.linkedinUrl === "https://www.linkedin.com/in/lee-builder", String(leeRow?.linkedinUrl));
  check("from the extension", leeRow?.source === "extension");
  check("the ids are the event's rows", first.attendeeIds.every((id) => roster.some((r) => r.id === id)));
  check("nobody became a contact", (await db.select().from(contacts).where(eq(contacts.userId, USER))).length === 0);

  const again = await logConnectionsAtEvent(USER, { eventId: mixer.id, people: [ana, lee] });
  roster = await listRosterForUser(USER, mixer.id);
  check("logging again adds nobody", again.added === 0 && roster.length === 2, `${roster.length} rows`);
  check("…and returns the same rows", [...again.attendeeIds].sort().join() === [...first.attendeeIds].sort().join());
  const leaked = await db.select().from(eventAttendees).where(and(eq(eventAttendees.eventId, theirs.id), eq(eventAttendees.userId, USER)));
  check("nothing lands on another user's event", leaked.length === 0);

  if (failures) {
    console.error(`\nsmoke-extension-log-connections: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nsmoke-extension-log-connections: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
