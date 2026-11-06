/**
 * The extension's guest-list save: a Luma/Partiful page the user has open becomes guests on
 * one event — found by its link or created — with no contact created and no guest token kept.
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-extension-event-roster.ts
 */
import "./smoke/_env";

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, eventAliases, eventAttendees, events } from "../src/db/schema";
import type { PageContext } from "../src/lib/extension/contract";
import { eventRosterRequestSchema, MAX_ROSTER_GUESTS } from "../src/lib/extension/contract.schema";
import { ExtensionRouteError } from "../src/lib/extension/http";
import { saveEventRoster } from "../src/lib/extension/event-roster";
import { setSurfaceComingSoon } from "../src/lib/surface-visibility";

const USER = "smoke-event-roster-user";
const OTHER = "smoke-event-roster-other";
const ADMIN = "smoke-event-roster-admin";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

function pageFor(
  overrides: Partial<PageContext> & { guests?: Array<{ name: string; profileUrl?: string }> }
): PageContext {
  const { guests = [], ...rest } = overrides;
  return {
    schemaVersion: 1,
    site: "luma",
    adapterVersion: "event-roster-1",
    kind: "list",
    url: "https://lu.ma/founders-mixer?tk=secret-guest-token",
    sourceUrl: "https://lu.ma/founders-mixer?tk=secret-guest-token",
    capturedAt: new Date().toISOString(),
    identity: {
      name: null,
      headline: null,
      title: null,
      company: null,
      location: null,
      school: null,
      email: null,
      handle: null,
      profileUrl: null,
      photoUrl: null,
    },
    roster: { title: "Founders Mixer", guests },
    text: { blob: "", truncated: false, charCount: 0, fromSelection: false },
    warnings: [],
    ...rest,
  };
}

async function refusal(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof ExtensionRouteError ? error.code : `unexpected: ${String(error)}`;
  }
}

async function main() {
  const db = await getDb();
  for (const u of [USER, OTHER]) {
    await db.delete(eventAliases).where(eq(eventAliases.userId, u));
    await db.delete(events).where(eq(events.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
  }

  // --- the wire schema --------------------------------------------------------------------
  const guests = [
    { name: "Ana Founder", profileUrl: "https://luma.com/user/usr-ana" },
    { name: "Lee  Builder", profileUrl: "https://luma.com/user/usr-lee" },
    // The avatar strip and the full list both name Ana: one row, not a refused INSERT.
    { name: "Ana Founder" },
  ];
  check("a roster page passes the request schema", eventRosterRequestSchema.safeParse({ page: pageFor({ guests }) }).success);
  const huge = Array.from({ length: MAX_ROSTER_GUESTS + 1 }, () => ({ name: "Guest Name" }));
  check("more guests than the cap are refused", !eventRosterRequestSchema.safeParse({ page: pageFor({ guests: huge }) }).success);

  // --- refusals ----------------------------------------------------------------------------
  check("no guests open → invalid_request", (await refusal(() => saveEventRoster(USER, pageFor({})))) === "invalid_request");
  check(
    "a page that is not the event → invalid_request",
    (await refusal(() => saveEventRoster(USER, pageFor({ guests, url: "https://www.linkedin.com/in/ana" })))) ===
      "invalid_request"
  );
  check(
    "a Luma link claimed as Partiful → invalid_request",
    (await refusal(() => saveEventRoster(USER, pageFor({ guests, site: "partiful" })))) === "invalid_request"
  );

  // --- the surface gate --------------------------------------------------------------------
  // Events is "coming soon" by default: until it is released, the extension saves nothing.
  check(
    "while Events is unreleased → not_found",
    (await refusal(() => saveEventRoster(USER, pageFor({ guests })))) === "not_found"
  );
  await setSurfaceComingSoon(ADMIN, "page.events", false);

  // --- the save ----------------------------------------------------------------------------
  const first = await saveEventRoster(USER, pageFor({ guests }));
  check("a new event is created", first.existingEvent === false && first.saved === 2, JSON.stringify(first));
  const [event] = await db.select().from(events).where(eq(events.id, first.eventId));
  check("the event keeps the page's title", event?.title === "Founders Mixer");
  check(
    "the stored link has no guest token",
    !!event?.url && !event.url.includes("tk=") && !event.url.includes("secret"),
    event?.url ?? ""
  );
  const rows = await db.select().from(eventAttendees).where(eq(eventAttendees.eventId, first.eventId));
  check("guests are saved once each, as extension rows", rows.length === 2 && rows.every((r) => r.source === "extension"));
  check("names are tidied", rows.some((r) => r.fullName === "Lee Builder"));
  check(
    "the profile link is kept as the external ref",
    rows.find((r) => r.fullName === "Ana Founder")?.externalRef === "https://luma.com/user/usr-ana"
  );
  check("nobody's email is invented", rows.every((r) => r.email === null));
  check("no contact is created", (await db.select().from(contacts).where(eq(contacts.userId, USER))).length === 0);

  // --- saving again ------------------------------------------------------------------------
  const again = await saveEventRoster(
    USER,
    pageFor({ guests: [...guests, { name: "Kim New" }], url: "https://luma.com/founders-mixer" })
  );
  check("the same event is found by its link (lu.ma and luma.com agree)", again.eventId === first.eventId && again.existingEvent);
  const after = await db.select().from(eventAttendees).where(eq(eventAttendees.eventId, first.eventId));
  check("a second save adds only the new guest", after.length === 3, String(after.length));

  // --- another user ------------------------------------------------------------------------
  const theirs = await saveEventRoster(OTHER, pageFor({ guests }));
  check("another user gets their own event", theirs.eventId !== first.eventId);
  const leaked = await db
    .select()
    .from(eventAttendees)
    .where(and(eq(eventAttendees.eventId, first.eventId), eq(eventAttendees.userId, OTHER)));
  check("…and nothing lands on this user's event", leaked.length === 0);

  await setSurfaceComingSoon(ADMIN, "page.events", true); // back to the code default

  if (failures) {
    console.error(`\nsmoke-extension-event-roster: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nsmoke-extension-event-roster: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
