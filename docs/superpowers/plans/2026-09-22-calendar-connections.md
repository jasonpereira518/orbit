# Calendar Connections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect an Apple/iCloud calendar over CalDAV, let every provider's calendars be chosen rather than assumed, expand recurring events, and close three Outlook parity gaps.

**Architecture:** iCloud becomes the third entry in `PROVIDER_TABLES` (`apple_connections`), so the existing scheduler claims, backs off and disarms it unchanged. A new `calendar_sources` table moves the sync cursor from the connection down to each calendar, for all three providers. A new `src/lib/recurrence.ts` expands `RRULE` masters into occurrences and is shared by the CalDAV connector and the existing ICS paths. `src/lib/connectors/apple-calendar.ts` implements the same three-function contract as the Google and Microsoft connectors.

**Tech Stack:** Next.js (App Router), TypeScript strict, Drizzle + Postgres (Neon http in prod, PGlite locally), `fast-xml-parser` (new), `tsx` smoke scripts.

**Spec:** `docs/superpowers/specs/2026-09-22-calendar-connections-design.md`

## Global Constraints

- **Inbound calendar connections are free.** Apple actions use `requireUserId()`, never `requireSyncUser()`. Pasted ICS/webcal URLs keep `requireSyncUser()` exactly as today.
- **`SCHEMA_VERSION` must be re-scanned immediately before Task 4 is committed**, against every remote branch *and* every local worktree. It was 86 on main on 2026-09-22, with 87 claimed by `brave-bouman` and 88 by PR #263. Pick the next free number and write the changelog comment in the existing format: `// <N> = <what the DDL adds>. Checked against every remote branch and local worktree on <date>.`
- **`alters` entries are one line each.** PGlite runs them through the extended query protocol, which rejects anything it reads as more than one command. The same text inside the `DDL` template may be multi-line, because that path splits on `;` first.
- **Every table with a `user_id` must be handled in `src/lib/user-data.ts`'s `STEPS`.** `scripts/smoke-purge.ts` enforces it.
- **Producers never append the contact id to an external id.** Use `calendarExternalIdBase(uid)`; `ingestEvents` appends `:${contactId}`.
- **Every new smoke script is registered in `scripts/run-smoke.ts`'s `MANIFEST`** or `--check` fails the whole suite. Pure-tier scripts import nothing from the DB; database-tier scripts start with `import "./smoke/_env";`.
- **PGlite is single-writer.** Stop this worktree's dev server before running any writing script, and note that the pglite tier shares one database per run — a test asserting "due" work must make itself the only tenant.
- Baselines: `npx tsc --noEmit` clean; `npx eslint` 0 errors (~44 warnings pre-exist — any error is yours).
- User-facing copy: `friendlyError` / `UserFacingError`, never `err.message`. No trailing periods in toasts, "Couldn't" not "failed", curly apostrophes (’). `scripts/smoke-toast-copy.ts` enforces this repo-wide.
- Inside the Integrations dialog only, copy avoids "API", "OAuth", "scope", "token", "webhook", "ICS", "feed", "endpoint", "sync" and "BYOK". Buttons are verb-first, sentence case.
- lucide-react is 1.x: the warning icon is `TriangleAlert`, there is no `AlertTriangle`.
- Never put Tailwind class names in code comments — Tailwind scans comments and compiles them.
- Run smokes with `npx tsx scripts/run-smoke.ts --only <name>`; the full check is `npx tsx scripts/run-smoke.ts --ci`.
- A fresh worktree has no `node_modules` and no `.env`: run `npm ci` **in the worktree** before anything else. Without `.env` it runs in demo mode against local PGlite, which is what every task here except 11 wants.
- Under machine load above ~100, `smoke-admin-render` and `smoke-instrumentation` time out for reasons unrelated to this work. Re-run them alone before suspecting your change.

---

### Task 1: Spike — what iCloud CalDAV actually supports

**Files:**
- Create: `docs/superpowers/specs/2026-09-22-icloud-caldav-findings.md`

**Interfaces:**
- Consumes: nothing.
- Produces: two answers every later task depends on — whether `sync-collection` (RFC 6578) is offered on iCloud calendars, and whether a `calendar-query` with `<expand>` returns expanded occurrences. Task 6 reads this file before writing `fetchCalendarPage`.

**This task is Jason's to drive.** It needs an Apple ID and an app-specific password. Claude must not type either; entering credentials is the user's action. Claude prepares the commands, Jason runs them and pastes the output.

- [ ] **Step 1: Prepare the probe commands**

Write these to the findings file as a "how this was measured" section. Jason runs them in his own terminal, substituting his Apple ID and app-specific password:

```bash
# 1. Principal discovery
curl -s -u "APPLE_ID:APP_PASSWORD" -X PROPFIND https://caldav.icloud.com/.well-known/caldav \
  -H "Depth: 0" -H "Content-Type: application/xml" \
  --data '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>' -i
```

```bash
# 2. Calendar home + calendar list (PRINCIPAL_URL from step 1)
curl -s -u "APPLE_ID:APP_PASSWORD" -X PROPFIND "PRINCIPAL_URL" \
  -H "Depth: 1" -H "Content-Type: application/xml" \
  --data '<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/><cs:getctag/><d:sync-token/><c:supported-calendar-component-set/></d:prop></d:propfind>'
```

```bash
# 3. Does sync-collection work? (CALENDAR_URL from step 2)
curl -s -u "APPLE_ID:APP_PASSWORD" -X REPORT "CALENDAR_URL" \
  -H "Depth: 1" -H "Content-Type: application/xml" \
  --data '<d:sync-collection xmlns:d="DAV:"><d:sync-token/><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>'
```

```bash
# 4. Does server-side expand work?
curl -s -u "APPLE_ID:APP_PASSWORD" -X REPORT "CALENDAR_URL" \
  -H "Depth: 1" -H "Content-Type: application/xml" \
  --data '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data><c:expand start="20260801T000000Z" end="20261001T000000Z"/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="20260801T000000Z" end="20261001T000000Z"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>'
```

- [ ] **Step 2: Record the answers**

Fill the findings file with, for each probe: the HTTP status, whether the expected element came back, and a redacted sample response (strip summaries, attendee emails and URLs — this file is committed). State explicitly:
- `sync-collection`: supported / not supported, and whether a `sync-token` was returned.
- `expand`: supported / not supported.
- Whether the calendar list includes shared or subscribed calendars, and how they are marked (`resourcetype`, or a missing `DAV:write` privilege).

- [ ] **Step 3: Decide the fallback**

If `sync-collection` is unsupported, record that Task 6 implements the ctag path only, and note in the findings that each pass then costs one full time-range query per calendar. If `expand` is unsupported, record that local expansion (Task 2) is the only path — which it is anyway for ICS feeds.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-22-icloud-caldav-findings.md
git commit -m "Record what iCloud CalDAV actually supports"
```

---

### Task 2: The recurrence expander

**Files:**
- Create: `src/lib/recurrence.ts`
- Create: `scripts/smoke-recurrence.ts`
- Modify: `scripts/run-smoke.ts` (MANIFEST)

**Interfaces:**
- Consumes: `ParsedCalendarEvent` from `@/lib/calendar-import`.
- Produces:
  - `export type RecurrenceRule = { freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"; interval: number; count: number | null; until: Date | null; byDay: string[]; byMonthDay: number[]; bySetPos: number[] };`
  - `export function parseRRule(line: string): RecurrenceRule | null`
  - `export function expandEvent(event: ParsedCalendarEvent, rule: RecurrenceRule | null, window: { from: Date; to: Date }, opts?: { exDates?: Date[]; cap?: number }): ParsedCalendarEvent[]`
  - `export const MAX_OCCURRENCES = 400;`
  - `export function occurrenceUid(uid: string, start: Date): string`

`occurrenceUid` is the single place the occurrence id shape is defined. A non-recurring event never goes through it, so stored ids keep their exact current value.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-recurrence.ts`. Pure tier — no `_env` import, no database.

```ts
/**
 * The recurrence expander.
 *
 * Pure tier. `parseIcsEvents` has always ignored RRULE, so a weekly 1:1 in a subscribed feed
 * was recorded once, at its first occurrence. These checks pin the expansion — and the one
 * property that protects stored data: a NON-recurring event's uid must come out byte-identical,
 * because `cal:<uid>` is already written on every interaction Orbit has ever ingested.
 */
import { expandEvent, occurrenceUid, parseRRule, MAX_OCCURRENCES } from "../src/lib/recurrence";
import type { ParsedCalendarEvent } from "../src/lib/calendar-import";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function evt(start: string, over: Partial<ParsedCalendarEvent> = {}): ParsedCalendarEvent {
  return {
    uid: "u1",
    summary: "1:1 with Priya",
    description: "",
    location: "",
    start: new Date(start),
    end: new Date(new Date(start).getTime() + 30 * 60000),
    attendees: [{ name: "Priya", email: "priya@example.com" }],
    organizer: null,
    timezone: "America/New_York",
    ...over,
  };
}

const WINDOW = { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-04-01T00:00:00Z") };

async function main() {
  // --- parseRRule ---
  const weekly = parseRRule("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TU");
  check("parses FREQ and BYDAY", weekly?.freq === "WEEKLY" && weekly?.byDay.join() === "TU");
  check("defaults INTERVAL to 1", parseRRule("RRULE:FREQ=DAILY")?.interval === 1);
  check("reads COUNT", parseRRule("RRULE:FREQ=DAILY;COUNT=3")?.count === 3);
  check(
    "reads UNTIL as a real date",
    parseRRule("RRULE:FREQ=DAILY;UNTIL=20260315T000000Z")?.until?.toISOString() ===
      "2026-03-15T00:00:00.000Z"
  );
  check("returns null for junk", parseRRule("RRULE:FREQ=NEVER") === null);

  // --- expansion ---
  const every = expandEvent(evt("2026-03-03T14:00:00Z"), parseRRule("RRULE:FREQ=WEEKLY"), WINDOW);
  check("weekly fills the window", every.length === 5, `got ${every.length}`);
  check("first occurrence keeps the master's start", every[0]?.start?.toISOString() === "2026-03-03T14:00:00.000Z");

  const counted = expandEvent(evt("2026-03-03T14:00:00Z"), parseRRule("RRULE:FREQ=WEEKLY;COUNT=2"), WINDOW);
  check("COUNT stops expansion", counted.length === 2, `got ${counted.length}`);

  const untilled = expandEvent(
    evt("2026-03-03T14:00:00Z"),
    parseRRule("RRULE:FREQ=WEEKLY;UNTIL=20260318T000000Z"),
    WINDOW
  );
  check("UNTIL stops expansion", untilled.length === 2, `got ${untilled.length}`);

  const skipped = expandEvent(evt("2026-03-03T14:00:00Z"), parseRRule("RRULE:FREQ=WEEKLY"), WINDOW, {
    exDates: [new Date("2026-03-10T14:00:00Z")],
  });
  check("EXDATE removes that occurrence", skipped.length === 4 && !skipped.some((e) => e.start?.toISOString() === "2026-03-10T14:00:00.000Z"));

  // DST: America/New_York moves on 2026-03-08. A 09:00 local meeting stays 09:00 local,
  // which means its UTC hour changes from 14:00 to 13:00.
  const dst = expandEvent(evt("2026-03-03T14:00:00Z"), parseRRule("RRULE:FREQ=WEEKLY"), WINDOW);
  check(
    "keeps local wall-clock across a DST change",
    dst[1]?.start?.toISOString() === "2026-03-10T13:00:00.000Z",
    `got ${dst[1]?.start?.toISOString()}`
  );

  const capped = expandEvent(evt("2026-03-01T00:00:00Z"), parseRRule("RRULE:FREQ=DAILY"), {
    from: new Date("2026-01-01T00:00:00Z"),
    to: new Date("2030-01-01T00:00:00Z"),
  });
  check("caps runaway rules", capped.length === MAX_OCCURRENCES, `got ${capped.length}`);

  // --- ids ---
  check(
    "a non-recurring event is returned untouched",
    expandEvent(evt("2026-03-03T14:00:00Z"), null, WINDOW)[0]?.uid === "u1"
  );
  check(
    "occurrences get a distinct, stable uid",
    occurrenceUid("u1", new Date("2026-03-10T13:00:00Z")) === "u1_2026-03-10T13:00:00.000Z"
  );
  check(
    "expanded occurrences carry occurrence uids",
    every[1]?.uid === occurrenceUid("u1", every[1]!.start!)
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll recurrence checks passed.");
}

main();
```

- [ ] **Step 2: Register the script and run it to verify it fails**

Add to `scripts/run-smoke.ts`'s `MANIFEST`, in the pure block beside the calendar entries:

```ts
  "smoke-recurrence": "pure",
```

Run: `npx tsx scripts/run-smoke.ts --only smoke-recurrence`
Expected: FAIL — cannot find module `../src/lib/recurrence`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/recurrence.ts`. Expand in the event's own zone by taking the master's local wall-clock fields, stepping the calendar date, and re-resolving to UTC — that is what keeps a 09:00 meeting at 09:00 across a DST change. Reuse `fromWallClockInput` from `@/lib/events/wall-clock`, which `calendar-import.ts` already uses for `TZID` handling.

```ts
/**
 * Expanding recurring calendar events.
 *
 * Google and Microsoft expand recurrences server-side (`singleEvents`, `calendarView`), so
 * nothing needed this until CalDAV — which returns a master VEVENT plus its RRULE. The same
 * gap has always been live for subscribed ICS feeds: `parseIcsEvents` ignores RRULE, so a
 * weekly 1:1 was recorded once, at its first occurrence.
 *
 * Deliberately a SUBSET of RFC 5545: FREQ/INTERVAL/COUNT/UNTIL/BYDAY/BYMONTHDAY/BYSETPOS,
 * plus EXDATE. Anything else returns the master alone rather than guessing — being wrong
 * about when a meeting happened is worse than recording one of them.
 */
import type { ParsedCalendarEvent } from "@/lib/calendar-import";
import { fromWallClockInput } from "@/lib/events/wall-clock";

/** A runaway or malformed rule must not be able to ingest an unbounded number of meetings. */
export const MAX_OCCURRENCES = 400;

export type RecurrenceRule = {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count: number | null;
  until: Date | null;
  byDay: string[];
  byMonthDay: number[];
  bySetPos: number[];
};

export function parseRRule(line: string): RecurrenceRule | null {
  // ...parse `KEY=VALUE;KEY=VALUE` after the first colon; return null when FREQ is missing or
  // not one of the four supported values.
}

/** The occurrence id shape. Non-recurring events never pass through here. */
export function occurrenceUid(uid: string, start: Date): string {
  return `${uid}_${start.toISOString()}`;
}

export function expandEvent(
  event: ParsedCalendarEvent,
  rule: RecurrenceRule | null,
  window: { from: Date; to: Date },
  opts: { exDates?: Date[]; cap?: number } = {}
): ParsedCalendarEvent[] {
  // No rule, or no start: the event stands alone, uid untouched.
  // Otherwise step the rule in the event's own zone, skip EXDATEs, clip to the window,
  // stop at COUNT / UNTIL / cap, and rewrite uid via occurrenceUid.
}
```

Write the real bodies; the comments above mark the contract, not placeholders to leave in.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx scripts/run-smoke.ts --only smoke-recurrence`
Expected: PASS, all checks.

Then: `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/recurrence.ts scripts/smoke-recurrence.ts scripts/run-smoke.ts
git commit -m "Expand recurring calendar events, in their own time zone"
```

---

### Task 3: Recurring events in subscribed ICS feeds

**Files:**
- Modify: `src/lib/calendar-import.ts` (`parseIcsEvents` keeps `RRULE`/`EXDATE` on the parsed event)
- Modify: `src/lib/calendar-sync.ts` (expand before `applyNetworkingEvents`)
- Modify: `scripts/smoke-recurrence.ts` (end-to-end case through `parseIcsEvents`)

**Interfaces:**
- Consumes: `expandEvent`, `parseRRule` (Task 2).
- Produces: two new optional fields on `ParsedCalendarEvent` — `rrule?: string | null` and `exDates?: Date[] | null` — which Task 6's CalDAV connector also reads.

- [ ] **Step 1: Write the failing test**

Append to `scripts/smoke-recurrence.ts`, before the `if (failures > 0)` block:

```ts
  // --- through the ICS parser ---
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:weekly-1",
    "SUMMARY:1:1 with Priya",
    "DTSTART;TZID=America/New_York:20260303T090000",
    "DTEND;TZID=America/New_York:20260303T093000",
    "RRULE:FREQ=WEEKLY;COUNT=3",
    "EXDATE;TZID=America/New_York:20260310T090000",
    "ATTENDEE;CN=Priya:mailto:priya@example.com",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const parsed = parseIcsEvents(ics);
  check("parser keeps the rule", parsed[0]?.rrule === "FREQ=WEEKLY;COUNT=3");
  check("parser keeps EXDATE", parsed[0]?.exDates?.length === 1);

  const fromFeed = expandEvent(parsed[0]!, parseRRule(`RRULE:${parsed[0]!.rrule}`), WINDOW, {
    exDates: parsed[0]!.exDates ?? [],
  });
  check("a weekly feed event yields its occurrences minus EXDATE", fromFeed.length === 2, `got ${fromFeed.length}`);
```

Add `parseIcsEvents` to the imports at the top of the file.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx scripts/run-smoke.ts --only smoke-recurrence`
Expected: FAIL — `parser keeps the rule` (the field does not exist yet).

- [ ] **Step 3: Carry the rule through the parser**

In `src/lib/calendar-import.ts`, add to the `ParsedCalendarEvent` type:

```ts
  /**
   * The raw RRULE value (no `RRULE:` prefix), when the source is a recurring master.
   * Parsing it is `recurrence.ts`'s job; this type only carries it.
   */
  rrule?: string | null;
  /** EXDATE instants, already resolved against the event's TZID. */
  exDates?: Date[] | null;
```

In `parseIcsEvents`, read them alongside the existing properties:

```ts
    const rrule = getProp(block, "RRULE") || null;
    const exDates = getAllPropLines(block, "EXDATE")
      .flatMap((line) => {
        const zone = /;TZID=([^:;]+)/i.exec(line.slice(0, line.indexOf(":") + 1))?.[1]?.trim() ?? timezone;
        return line
          .slice(line.indexOf(":") + 1)
          .split(",")
          .map((raw) => parseIcsDate(raw.trim(), zone));
      })
      .filter((d): d is Date => d !== null);
```

and include `rrule` and `exDates: exDates.length > 0 ? exDates : null` in the pushed event.

- [ ] **Step 4: Expand on the subscription path**

In `src/lib/calendar-sync.ts`, after the feed is parsed and before `applyNetworkingEvents` runs, expand each event over the same window the subscription already uses:

```ts
  const expanded = parsed.flatMap((event) =>
    expandEvent(event, event.rrule ? parseRRule(`RRULE:${event.rrule}`) : null, window, {
      exDates: event.exDates ?? [],
    })
  );
```

Import `expandEvent` and `parseRRule` from `@/lib/recurrence`. Pass `expanded` where `parsed` was passed.

- [ ] **Step 5: Run the tests**

Run: `npx tsx scripts/run-smoke.ts --only smoke-recurrence`
Expected: PASS.

Run: `npx tsx scripts/run-smoke.ts --only smoke-parsers --only smoke-calendar-sync`
Expected: PASS — the external-id assertion in `smoke-parsers.ts` must still hold, since single events are untouched.

Run: `npx tsc --noEmit` — clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/calendar-import.ts src/lib/calendar-sync.ts scripts/smoke-recurrence.ts
git commit -m "See every occurrence of a recurring meeting in a subscribed calendar"
```

---

### Task 4: Schema — `apple_connections` and `calendar_sources`

**Files:**
- Modify: `src/db/schema.ts` (two new `pgTable` exports)
- Modify: `src/db/index.ts` (DDL template, `alters`, the sync-state `flatMap`, `SCHEMA_VERSION`)
- Modify: `src/lib/user-data.ts` (the `connections` step)
- Create: `scripts/smoke-calendar-sources.ts`
- Modify: `scripts/run-smoke.ts` (MANIFEST)

**Interfaces:**
- Consumes: `syncStateColumns()`, `ProviderSyncCursor`, `CalendarSyncCursor` from `src/db/schema.ts`.
- Produces: `appleConnections` and `calendarSources` table exports; the column set every later task reads.

- [ ] **Step 1: Re-scan the schema version**

Run:

```bash
git fetch --all --quiet && git grep -h "SCHEMA_VERSION = " $(git for-each-ref --format='%(refname)' refs/remotes refs/heads) -- src/db/index.ts | sort -u
```

Also check every local worktree: `git worktree list`. Record the highest number found and use the next free one. Do not proceed on a guess.

- [ ] **Step 2: Write the failing test**

Create `scripts/smoke-calendar-sources.ts` — database tier, so it starts with the env import:

```ts
import "./smoke/_env";
/**
 * `calendar_sources` and `apple_connections`.
 *
 * The migration is the risky half: every existing Google and Outlook connection must come out
 * with exactly ONE source row carrying the cursor it already had. A missed cursor means a full
 * resync for that user; a doubled row means the same calendar synced twice.
 */
import { getDb, reconcileSchema } from "../src/db";
import { appleConnections, calendarSources, gmailConnections } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { seedCalendarSources } from "../src/lib/calendar-sources";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = `smoke-cal-src-${Date.now()}`;

async function main() {
  await reconcileSchema();
  const db = await getDb();

  // A Google connection that already synced, with a cursor on the connection row.
  await db.insert(gmailConnections).values({
    userId: USER,
    emailAddress: "someone@example.com",
    accessTokenEncrypted: "x",
    scopes: "https://www.googleapis.com/auth/calendar.readonly",
    syncCursor: { calendar: { syncToken: "tok-123", pageToken: null } },
    nextSyncAt: new Date(),
  });

  await seedCalendarSources(USER);
  const seeded = await db.select().from(calendarSources).where(eq(calendarSources.userId, USER));
  check("one source per existing connection", seeded.length === 1, `got ${seeded.length}`);
  check("the connection's cursor moved onto it", seeded[0]?.syncCursor?.syncToken === "tok-123");
  check("it is enabled", seeded[0]?.enabled === 1);

  // Running twice must not double it — the scheduler calls this on every pass.
  await seedCalendarSources(USER);
  const again = await db.select().from(calendarSources).where(eq(calendarSources.userId, USER));
  check("seeding is idempotent", again.length === 1, `got ${again.length}`);

  // An Apple connection stores a password, not tokens.
  await db.insert(appleConnections).values({
    userId: `${USER}-apple`,
    emailAddress: "someone@icloud.com",
    appPasswordEncrypted: "iv:tag:data",
    principalUrl: "https://caldav.icloud.com/123/principal/",
    calendarHomeUrl: "https://caldav.icloud.com/123/calendars/",
  });
  const apple = await db.query.appleConnections.findFirst({
    where: eq(appleConnections.userId, `${USER}-apple`),
  });
  check("apple connection stores its home url", Boolean(apple?.calendarHomeUrl));
  check("apple connection defaults to active", apple?.status === "active");

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll calendar source checks passed.");
  process.exit(0);
}

main();
```

Note the explicit `process.exit(0)` — a tsx script that opened a database will not exit on its own.

Register it:

```ts
  "smoke-calendar-sources": "pglite",
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx tsx scripts/run-smoke.ts --only smoke-calendar-sources`
Expected: FAIL — cannot find `calendarSources` / `appleConnections` / `../src/lib/calendar-sources`.

- [ ] **Step 4: Add the tables**

In `src/db/schema.ts`, beside `outlookConnections`:

```ts
/**
 * An iCloud CalDAV connection.
 *
 * Shaped like `gmail_connections` / `outlook_connections` — same status column, same
 * `syncStateColumns()` — so `provider-connections.ts` can treat all three alike. The
 * difference is the credential: Apple has no OAuth for CalDAV, so this holds an
 * app-specific password the user generated at appleid.apple.com, encrypted at rest.
 * It is long-lived and revocable only by the user, at Apple.
 */
export const appleConnections = pgTable(
  "apple_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull().unique(),
    /** The Apple ID itself, which is also the calendar owner's address for self-detection. */
    emailAddress: text("email_address").notNull(),
    appPasswordEncrypted: text("app_password_encrypted").notNull(),
    /** Resolved once at connect time; re-resolved only on a reconnect. */
    principalUrl: text("principal_url"),
    calendarHomeUrl: text("calendar_home_url"),
    /** Same two values, same reasoning, as the other connection tables. */
    status: text("status").$type<"active" | "needs_reauth">().default("active").notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    ...syncStateColumns(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("apple_connections_user_idx").on(t.userId),
    index("apple_connections_due_idx").on(t.nextSyncAt).where(sql`next_sync_at is not null`),
  ]
);

/**
 * One row per calendar Orbit could read, for every provider.
 *
 * Before this, the cursor lived on the connection and each provider synced exactly one
 * calendar — Google's `primary`, Graph's default. iCloud accounts routinely hold several with
 * no obvious primary, so the choice becomes the user's and the cursor moves down here.
 *
 * `provider` + `connectionId` rather than a foreign key: the three connection tables are
 * separate by design (see `provider-connections.ts`), so there is no single parent to
 * reference. Deletes are handled explicitly in `user-data.ts`.
 */
export const calendarSources = pgTable(
  "calendar_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    provider: text("provider").$type<"google" | "microsoft" | "apple">().notNull(),
    connectionId: uuid("connection_id").notNull(),
    /** The provider's own id: `primary`, a Graph calendar id, or a CalDAV collection path. */
    calendarId: text("calendar_id").notNull(),
    displayName: text("display_name"),
    color: text("color"),
    /** True for subscribed and other people's calendars. Sub-project 2 must not write to these. */
    readOnly: integer("read_only").notNull().default(0),
    enabled: integer("enabled").notNull().default(1),
    syncCursor: jsonb("sync_cursor").$type<CalendarSyncCursor>(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("calendar_sources_user_idx").on(t.userId),
    uniqueIndex("calendar_sources_conn_cal_uidx").on(t.connectionId, t.calendarId),
  ]
);
```

The unique index is what makes seeding idempotent — Step 6's insert uses `onConflictDoNothing`.

- [ ] **Step 5: Add the DDL**

In `src/db/index.ts`, add both `CREATE TABLE IF NOT EXISTS` statements plus their indexes to the `DDL` template (multi-line is fine there), and add single-line copies to `alters`:

```ts
  `CREATE TABLE IF NOT EXISTS apple_connections (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL UNIQUE, email_address text NOT NULL, app_password_encrypted text NOT NULL, principal_url text, calendar_home_url text, status text NOT NULL DEFAULT 'active', last_synced_at timestamptz, sync_cursor jsonb, next_sync_at timestamptz, sync_status text, sync_started_at timestamptz, sync_error text, sync_failures integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS apple_connections_user_idx ON apple_connections(user_id)`,
  `CREATE TABLE IF NOT EXISTS calendar_sources (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, provider text NOT NULL, connection_id uuid NOT NULL, calendar_id text NOT NULL, display_name text, color text, read_only integer NOT NULL DEFAULT 0, enabled integer NOT NULL DEFAULT 1, sync_cursor jsonb, last_synced_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS calendar_sources_user_idx ON calendar_sources(user_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS calendar_sources_conn_cal_uidx ON calendar_sources(connection_id, calendar_id)`,
```

Add `"apple_connections"` to the sync-state `flatMap` list so an older database gains the columns and the partial due index.

Bump `SCHEMA_VERSION` to the number from Step 1, with a changelog comment in the existing format.

- [ ] **Step 6: Write the seeder**

Create `src/lib/calendar-sources.ts`:

```ts
/**
 * Reading and seeding `calendar_sources`.
 *
 * `seedCalendarSources` is the migration: it is idempotent (the unique index does the work)
 * and runs on every sync pass, so a connection made before this shipped gains its row the
 * first time it is claimed — and carries its existing cursor across, so nobody pays for a
 * full resync.
 */
export async function seedCalendarSources(userId: string): Promise<void>
export async function listCalendarSources(userId: string): Promise<CalendarSourceRow[]>
export async function enabledSourcesFor(connectionId: string): Promise<CalendarSourceRow[]>
export async function saveSourceCursor(id: string, cursor: CalendarSyncCursor | null, syncedAt: Date): Promise<void>
export async function setSourceEnabled(userId: string, id: string, enabled: boolean): Promise<void>
```

Seeding reads `gmail_connections` and `outlook_connections` for the user, and inserts one row each — `calendarId: "primary"` for Google, `"default"` for Microsoft — with `syncCursor` taken from the connection's `syncCursor.calendar`.

- [ ] **Step 7: Register the tables for deletion**

In `src/lib/user-data.ts`'s `connections` step, add `own(appleConnections)` and `own(calendarSources)` to `exports`, both tables to `counts`, and explicit deletes in `run`:

```ts
      await db.delete(calendarSources).where(eq(calendarSources.userId, userId));
      await db.delete(appleConnections).where(eq(appleConnections.userId, userId));
```

- [ ] **Step 8: Run the tests**

Run: `npx tsx scripts/run-smoke.ts --only smoke-calendar-sources --only smoke-purge --only smoke-schema-upgrade`
Expected: PASS. `smoke-purge` is the one that proves no user-scoped table was left out.

Run: `npx tsc --noEmit` — clean.

Regenerate the DDL lock if the repo's check asks for it: `npx tsx scripts/schema-ddl-lock.ts` (or whatever `npm run` script the guard names), then re-run `npx tsx scripts/run-smoke.ts --only smoke-schema-ddl`.

- [ ] **Step 9: Commit**

```bash
git add src/db/schema.ts src/db/index.ts src/lib/user-data.ts src/lib/calendar-sources.ts scripts/smoke-calendar-sources.ts scripts/run-smoke.ts scripts/schema-ddl.lock.json
git commit -m "Store an iCloud connection, and one row per calendar Orbit can read"
```

---

### Task 5: The CalDAV client

**Files:**
- Create: `src/lib/caldav/client.ts`
- Create: `src/lib/caldav/fixtures/` (recorded, redacted XML from Task 1)
- Create: `scripts/smoke-caldav-client.ts`
- Modify: `scripts/run-smoke.ts` (MANIFEST), `package.json` (`fast-xml-parser`)

**Interfaces:**
- Consumes: Task 1's findings; `guardedFetchText` from `@/lib/events/guarded-fetch`.
- Produces:
  - `export type CalDavCredentials = { username: string; password: string };`
  - `export type CalDavCalendar = { url: string; displayName: string; color: string | null; readOnly: boolean; ctag: string | null; supportsSync: boolean };`
  - `export class CalDavAuthError extends Error` — thrown on 401, meaning the app-specific password was revoked.
  - `export async function discoverPrincipal(creds: CalDavCredentials, deps?: { fetchImpl?: typeof fetch }): Promise<{ principalUrl: string; calendarHomeUrl: string }>`
  - `export async function listCalendars(creds: CalDavCredentials, calendarHomeUrl: string, deps?): Promise<CalDavCalendar[]>`
  - `export async function fetchChanges(creds: CalDavCredentials, calendarUrl: string, cursor: CalendarSyncCursor | null, window: { from: Date; to: Date }, deps?): Promise<{ icsDocuments: string[]; nextSyncToken: string | null; tombstones: number }>`

- [ ] **Step 1: Add the dependency**

```bash
npm install fast-xml-parser
```

- [ ] **Step 2: Write the failing test**

Create `scripts/smoke-caldav-client.ts`, pure tier, driven entirely by the redacted fixtures from Task 1 through a stubbed `fetch`. Cover: principal discovery returns both URLs; the calendar list marks a subscribed calendar read-only; a 401 raises `CalDavAuthError` and not a generic error; a `sync-collection` response yields its token; a calendar without sync support falls back to the time-range query; deleted hrefs are counted as tombstones; a non-Apple host is refused.

Register: `"smoke-caldav-client": "pure",`

- [ ] **Step 3: Run it to verify it fails**

Run: `npx tsx scripts/run-smoke.ts --only smoke-caldav-client`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the client**

Create `src/lib/caldav/client.ts`. Requests go through `guardedFetchText` with `contentTypes: ["application/xml", "text/xml", "text/calendar"]`, a raised `maxBytes` for calendar bodies, and the `Authorization: Basic` header. Pin the host: refuse any URL whose hostname is not `caldav.icloud.com` or a `*.icloud.com` subdomain, and refuse redirects off it — a credentialed request must never follow a redirect to an arbitrary host.

Parse with `fast-xml-parser` configured to keep namespace prefixes off (`removeNSPrefix: true`), so `d:response` and `D:response` both read as `response`.

- [ ] **Step 5: Run the tests**

Run: `npx tsx scripts/run-smoke.ts --only smoke-caldav-client`
Expected: PASS.

Run: `npx tsc --noEmit` — clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/caldav package.json package-lock.json scripts/smoke-caldav-client.ts scripts/run-smoke.ts
git commit -m "Talk CalDAV to iCloud, over a guarded fetch pinned to Apple"
```

---

### Task 6: The Apple calendar connector

**Files:**
- Create: `src/lib/connectors/apple-calendar.ts`
- Create: `scripts/smoke-apple-calendar-map.ts`
- Modify: `scripts/run-smoke.ts` (MANIFEST)

**Interfaces:**
- Consumes: Task 5's client; `expandEvent`/`parseRRule` (Task 2); `parseIcsEvents` (Task 3); `CalendarSyncTokenExpiredError`, `toNetworkEvents`, `CalendarFetchResult`, `CALENDAR_WINDOW_PAST_MS`, `CALENDAR_WINDOW_FUTURE_MS` from `@/lib/connectors/google-calendar`.
- Produces, mirroring `microsoft-calendar.ts` exactly:
  - `export { CalendarSyncTokenExpiredError, toNetworkEvents };`
  - `export type FetchPageOptions = { creds: CalDavCredentials; calendarUrl: string; cursor: CalendarSyncCursor | null; ownerEmail: string; now?: Date; fetchImpl?: typeof fetch };`
  - `export async function fetchCalendarPage(opts: FetchPageOptions): Promise<CalendarFetchResult>`
  - `export function advanceCursor(previous: CalendarSyncCursor | null, page: CalendarFetchResult): CalendarSyncCursor`

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-apple-calendar-map.ts`, pure tier, mirroring `smoke-outlook-calendar-map.ts`'s structure (same `check` helper, same `stubFetch` shape, same banner comments). Assert:

```ts
  check("uid comes from the VEVENT UID", first?.uid === "abc-123");
  check("the external id base is unchanged for a single event", toNetworkEvents([single], ["me@icloud.com"])[0]?.externalIdBase === "cal:abc-123");
  check("a recurring master expands", page.events.length === 4, `got ${page.events.length}`);
  check("the owner is excluded from counterparts", !participants.some((p) => p.email === "me@icloud.com"));
  check("a deleted href counts as a tombstone", page.tombstones === 1);
  check("an incremental run sends the stored sync token and no window", calls[0]?.includes("tok-abc") && !calls[0]?.includes("time-range"));
  check("an expired token is its own error", err instanceof CalendarSyncTokenExpiredError);
  check("the cursor is never adopted while pages remain", advanceCursor(null, { ...page, nextPageToken: "more" }).syncToken === undefined);
```

Register: `"smoke-apple-calendar-map": "pure",`

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx scripts/run-smoke.ts --only smoke-apple-calendar-map`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the connector**

Create `src/lib/connectors/apple-calendar.ts`. `fetchCalendarPage` calls `fetchChanges`, parses each returned ICS document with `parseIcsEvents`, expands recurrences over the same 90/60-day window the other connectors use, and returns a `CalendarFetchResult` with `selfEmails: [ownerEmail.toLowerCase()]` — Apple, like Graph, has no per-attendee self flag.

Translate the client's auth failure at this boundary: catch `CalDavAuthError` and rethrow as `ReauthRequiredError` (from `@/lib/errors`), which the scheduler already treats as non-retryable.

If Task 1 found `sync-collection` unsupported, `advanceCursor` stores the ctag instead of a sync token; the shape is the same and the scheduler does not care.

- [ ] **Step 4: Run the tests**

Run: `npx tsx scripts/run-smoke.ts --only smoke-apple-calendar-map --only smoke-parsers`
Expected: PASS — `smoke-parsers` re-proves the frozen external-id formula.

Run: `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/connectors/apple-calendar.ts scripts/smoke-apple-calendar-map.ts scripts/run-smoke.ts
git commit -m "Read an iCloud calendar the way Orbit reads Google and Outlook"
```

---

### Task 7: The third provider, and per-calendar sync

**Files:**
- Modify: `src/lib/provider-connections.ts` (`SyncProvider`, `PROVIDER_TABLES`, `loadCoverageSources`)
- Modify: `src/lib/sync-scheduler.ts` (`SyncDeps`, `DEFAULT_DEPS`, `syncAppleCalendar`, a third claim block, per-source fan-out)
- Modify: `scripts/smoke-sync-scheduler.ts`, `scripts/smoke-provider-connections.ts`

**Interfaces:**
- Consumes: Task 4's tables and `enabledSourcesFor`/`saveSourceCursor`; Task 6's connector.
- Produces: `SyncProvider` widened to `"google" | "microsoft" | "apple"`; `syncAppleCalendar(conn, stats, now, deps)`; `SyncRunStats` gains no new fields — Apple reuses `synced`/`failed`/`claimed`.

- [ ] **Step 1: Write the failing test**

Add to `scripts/smoke-sync-scheduler.ts`, following its existing stub-and-assert style:

```ts
  check("an armed apple connection is claimed and synced", stats.synced === 1);
  check("a revoked app password disarms rather than retrying", afterRevoke.nextSyncAt === null && afterRevoke.syncFailures < MAX_SYNC_FAILURES);
  check("each enabled calendar advances its own cursor", sourceA.syncCursor?.syncToken === "a2" && sourceB.syncCursor?.syncToken === "b2");
  check("a disabled calendar is never fetched", !fetched.includes(disabledCalendarUrl));
  check("a spent budget leaves remaining calendars due now", stats.budgetExhausted && conn.nextSyncAt !== null);
```

And to `scripts/smoke-provider-connections.ts`:

```ts
  check("apple rows are claimable like the other two", claimed.some((c) => c.provider === "apple"));
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx scripts/run-smoke.ts --only smoke-sync-scheduler --only smoke-provider-connections`
Expected: FAIL — `"apple"` is not assignable to `SyncProvider`.

- [ ] **Step 3: Register the provider**

In `src/lib/provider-connections.ts`:

```ts
export type SyncProvider = "google" | "microsoft" | "apple";

const PROVIDER_TABLES: Record<SyncProvider, string> = {
  google: "gmail_connections",
  microsoft: "outlook_connections",
  apple: "apple_connections",
};
```

The claim SQL is shared and already selects the columns `apple_connections` has, except `scopes`, which that table does not carry — add `scopes text` to the table, or select `NULL::text AS scopes` for Apple. Prefer widening the claim to `COALESCE(scopes, NULL)` only if the table has the column; the simpler option is to give `apple_connections` a `scopes` column that is always null, and say so in a comment. Pick one and make it explicit.

Add Apple to `loadCoverageSources`'s `calendar_connected` chain:

```sql
      OR EXISTS (SELECT 1 FROM apple_connections WHERE user_id = ${userId} AND status = 'active')
```

Not to `mail_connected` — Orbit reads no Apple mail.

- [ ] **Step 4: Sync per calendar**

In `src/lib/sync-scheduler.ts`, add `syncAppleCalendar`, modelled on `syncMicrosoftCalendar` but looping over calendars:

```ts
/**
 * Sync one iCloud connection. Unlike Google and Microsoft, a connection covers several
 * calendars, so the claim stays at the connection and the loop fans out over its enabled
 * sources — checking the remaining budget BETWEEN calendars, so a five-calendar account
 * degrades by syncing fewer of them this pass rather than by overrunning the function.
 * Oldest cursor first, so no calendar can starve behind a busy one.
 */
async function syncAppleCalendar(
  conn: ClaimedConnection,
  stats: SyncRunStats,
  now: Date,
  deps: SyncDeps
): Promise<void> {
  const creds = await appleCredentials(conn.id);
  const sources = await enabledSourcesFor(conn.id);
  const ctx = await openIngestContext(conn.userId, {
    source: "apple_calendar",
    createsContacts: true,
  });
  const deadline = deadlineAfter(PER_CONNECTION_BUDGET_MS);
  let exhausted = false;

  for (const source of sources) {
    if (deadlineReached(deadline)) { exhausted = true; break; }
    // ...same page loop as the Microsoft path, with `cursor = source.syncCursor`, ending in
    // `await saveSourceCursor(source.id, cursor, now)`.
  }

  await finalizeIngest(ctx);
  await markSyncResult(conn.provider, conn.id, {
    ok: true,
    cursor: conn.syncCursor,
    nextSyncAt: exhausted ? now : new Date(now.getTime() + SYNC_INTERVAL_MS),
  });
}
```

Add the third claim block after the Microsoft one (currently ending at `sync-scheduler.ts:507`), before the ICS block. It has no scope check — Apple grants no scopes — and calls `seedCalendarSources(conn.userId)` before fanning out, which is how pre-existing Google and Outlook connections acquire their source rows.

Extend the Google and Microsoft paths to read and write their cursor through `calendar_sources` too, falling back to the connection cursor when no row exists yet.

- [ ] **Step 5: Run the tests**

Run: `npx tsx scripts/run-smoke.ts --only smoke-sync-scheduler --only smoke-provider-connections --only smoke-calendar-sources --only smoke-sync-columns`
Expected: PASS.

Run: `npx tsc --noEmit` — clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/provider-connections.ts src/lib/sync-scheduler.ts src/lib/calendar-sources.ts scripts/smoke-sync-scheduler.ts scripts/smoke-provider-connections.ts
git commit -m "Sync every calendar a connection covers, iCloud included"
```

---

### Task 8: Connect and manage an Apple account

**Files:**
- Create: `src/actions/apple.ts`
- Create: `src/lib/apple.ts` (status reader + credential helper)
- Create: `scripts/smoke-apple-actions.ts`
- Modify: `scripts/run-smoke.ts` (MANIFEST)

**Interfaces:**
- Consumes: Task 5's `discoverPrincipal`/`listCalendars`; `encrypt`/`decryptOrNull`; `asActionResult`/`UserFacingError`.
- Produces:
  - `export type AppleConnectionStatus = { connected: boolean; emailAddress: string | null; status: ConnectionHealth | null; lastSyncedAt: string | null; nextSyncAt: string | null; syncError: string | null; calendars: Array<{ id: string; name: string; enabled: boolean; readOnly: boolean }> };`
  - `export async function getAppleConnectionStatus(): Promise<AppleConnectionStatus>`
  - `export async function connectApple(input: { appleId: string; appPassword: string }): Promise<ActionResult<{ calendars: number }>>`
  - `export async function setAppleCalendarEnabled(input: { sourceId: string; enabled: boolean }): Promise<ActionResult<null>>`
  - `export async function disconnectApple(): Promise<void>`

**The status type never carries the password, encrypted or otherwise.** `appleCredentials(connectionId)` in `src/lib/apple.ts` is the only decrypt site.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-apple-actions.ts` (pglite tier, starts with `import "./smoke/_env";`). With a stubbed CalDAV client, assert:

```ts
  check("a bad password is returned as data, not thrown", result.ok === false && result.error.length > 0);
  check("nothing is stored when discovery fails", (await countRows()) === 0);
  check("a good connection stores the home url and seeds its calendars", stored?.calendarHomeUrl && sources.length === 3);
  check("the stored password is not the plaintext", stored?.appPasswordEncrypted !== "app-specific-password");
  check("status never returns the password", !JSON.stringify(status).includes("app-specific-password"));
  check("connecting is free — no sync entitlement is required", connectedOnFreePlan.ok === true);
  check("disconnect removes the connection and its calendars", after.connection === undefined && after.sources.length === 0);
```

Register: `"smoke-apple-actions": "pglite",`

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx scripts/run-smoke.ts --only smoke-apple-actions`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the actions**

`connectApple` walks discovery first and only writes a row if the whole walk succeeds, so a wrong password fails at the form:

```ts
"use server";

export async function connectApple(input: { appleId: string; appPassword: string }) {
  return asActionResult(async () => {
    // Free, like Google and Microsoft — see the spec's settled decision 4.
    const userId = await requireUserId();
    const appleId = input.appleId.trim().toLowerCase();
    const password = input.appPassword.trim();
    if (!appleId || !password) throw new UserFacingError("Enter your Apple ID and app-specific password");

    let discovered;
    try {
      discovered = await discoverPrincipal({ username: appleId, password });
    } catch (err) {
      if (err instanceof CalDavAuthError) {
        throw new UserFacingError("Apple didn’t accept that. Check the app-specific password and try again");
      }
      throw err;
    }
    // ...list calendars, insert the connection with encrypt(password), insert one
    // calendar_sources row per calendar (default enabled, shared/subscribed disabled),
    // arm sync with nextSyncAt: new Date().
  });
}
```

Remember the `"use server"` export rule: only async functions, and `export type X = …` declared inline — never `export type { … }` re-exports, which silently kill every export in the file.

- [ ] **Step 4: Run the tests**

Run: `npx tsx scripts/run-smoke.ts --only smoke-apple-actions --only smoke-purge --only smoke-toast-copy`
Expected: PASS.

Run: `npx tsc --noEmit` and `npx eslint src/actions/apple.ts src/lib/apple.ts` — clean, 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/actions/apple.ts src/lib/apple.ts scripts/smoke-apple-actions.ts scripts/run-smoke.ts
git commit -m "Connect an iCloud account with an app-specific password"
```

---

### Task 9: Outlook and Apple parity

**Files:**
- Modify: `src/lib/embedding-backfill.ts:329` (`PENDING_MEETINGS`)
- Modify: `src/lib/account-alerts.ts` (per-provider calendar alert)
- Modify: `src/lib/sync-scheduler.ts` (event discovery on all three passes)
- Modify: `scripts/smoke-account-alerts.ts`, `scripts/smoke-embeddings.ts`

**Interfaces:**
- Consumes: Task 7's provider union.
- Produces: `HealthCode` gains `"connection.microsoft_calendar"` and `"connection.apple_calendar"`; `AccountAlertInput` gains `microsoftCalendar` and `appleCalendar` fields shaped exactly like the existing `googleCalendar`.

- [ ] **Step 1: Write the failing test**

In `scripts/smoke-account-alerts.ts`:

```ts
  check("a paused Outlook calendar raises its own alert", codes.includes("connection.microsoft_calendar"));
  check("a paused Apple calendar raises its own alert", codes.includes("connection.apple_calendar"));
  check("a dead grant suppresses the calendar alert", !codesWithDeadGrant.includes("connection.microsoft_calendar"));
```

In `scripts/smoke-embeddings.ts`:

```ts
  check("outlook meetings are queued for embedding", pending.includes(outlookInteractionId));
  check("apple meetings are queued for embedding", pending.includes(appleInteractionId));
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx scripts/run-smoke.ts --only smoke-account-alerts --only smoke-embeddings`
Expected: FAIL on all five.

- [ ] **Step 3: Fix the embedding source list**

`src/lib/embedding-backfill.ts:329`:

```ts
  WHERE i.source IN ('calendar_import', 'calendar_sync', 'google_calendar', 'microsoft_calendar', 'apple_calendar')
```

This is a live bug for Outlook users today — their meetings have never reached chat or search.

- [ ] **Step 4: Generalize the alert**

In `src/lib/account-alerts.ts`, add the two codes to the `HealthCode` union, `KIND_BY_CODE` and `CODE_RANK` (beside `connection.google_calendar`), the two input fields, the two finding blocks (each gated on its own connection being healthy, the way Google's is), and the two render cases. Apple's CTA points at Settings rather than `/imports`, and its body says the app-specific password may have been revoked at Apple — that is the only way an Apple connection dies.

- [ ] **Step 5: Run event discovery on every pass**

Move the `recordDiscoveryCandidates` block out of the Google-only path into a helper both other paths call, so a Luma invite in an Outlook or iCloud calendar is found too.

- [ ] **Step 6: Run the tests**

Run: `npx tsx scripts/run-smoke.ts --only smoke-account-alerts --only smoke-embeddings --only smoke-sync-scheduler`
Expected: PASS.

Run: `npx tsc --noEmit` — clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/embedding-backfill.ts src/lib/account-alerts.ts src/lib/sync-scheduler.ts scripts/smoke-account-alerts.ts scripts/smoke-embeddings.ts
git commit -m "Give Outlook and iCloud meetings what Google's already had"
```

---

### Task 10: The Apple page and the calendar picker

**Files:**
- Create: `src/components/settings/apple-account-page.tsx`
- Create: `src/components/settings/calendar-picker.tsx`
- Modify: `src/components/settings/sections.ts`, `integration-ui.tsx`, `integrations-dialog.tsx`, `integrations-overview.tsx`, `account-page.tsx`, `provider-marks.tsx`
- Modify: `src/lib/integration-status.ts`, `src/lib/data-categories.ts`, `src/actions/integrations.ts`
- Modify: `src/components/imports/calendar-subscribe-panel.tsx` (copy only)
- Modify: `scripts/smoke-settings-layout.ts`

**BLOCKED until** `claude/settings-popup-redesign-0ed30d` has its account pages mounted (its P2b Task 5 Step 2). `GoogleAccountPage` exists there but is not wired into `Panel`, and `MicrosoftAccountPage` does not exist yet. Build this task on top of that branch, not main.

**Interfaces:**
- Consumes: Task 8's actions; `AccountPageShell`, `FeatureRow`, `rowControl` from `account-page.tsx`.
- Produces: `IntegrationTabId` gains `"apple"`; `AccountProvider` gains `"apple"`; `DisconnectProvider` gains `"apple"`.

- [ ] **Step 1: Write the failing test**

In `scripts/smoke-settings-layout.ts`, add:

```ts
  check("the apple page exists and resolves a surface", INTEGRATION_TABS.some((t) => t.id === "apple"));
  check("?integration=apple round-trips", resolveIntegrationParam("apple")?.view === "apple");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx scripts/run-smoke.ts --only smoke-settings-layout`
Expected: FAIL — no apple tab.

- [ ] **Step 3: Register the page**

Four edits, three of which the compiler will demand:

```ts
// sections.ts — after microsoft, before linkedin
  { id: "apple", label: "Apple", group: "accounts", surface: "page.imports" },
```

```ts
// integration-ui.tsx — ICONS is a total Record; omitting this is a compile error
  apple: CalendarDays,
```

```ts
// data-categories.ts — DISCONNECT_DELETE_CATEGORIES is a total Record
  apple: [],
```

```ts
// integration-status.ts
export type AccountProvider = "google" | "microsoft" | "apple";
```

Then `PROVIDER_NAME.apple = "Apple"`, `DISCONNECT_PROVIDER.apple = "apple"`, the `PROVIDERS` array entry, `integrations-overview.tsx`'s `DESCRIPTIONS` and its `id === "google" || id === "microsoft"` narrowing, the `Panel` switch case, and `actions/integrations.ts` populating `accounts.apple` / `pages.apple`.

- [ ] **Step 4: Build the page and picker**

`AppleAccountPage` uses `AccountPageShell` with its own connect form rather than `useConnection` — there is no OAuth return to own, so none of the param-stripping machinery applies. The form follows `AiSettings`' secret pattern exactly: the password lives only in local `useState`, the input is `type="password"`, a saved credential is shown as a placeholder and never a value, and the action returns `{ ok: false, error }` rather than throwing.

`CalendarPicker` renders inside a `FeatureRow`'s `children` slot — a checkbox list with the calendar names, read-only ones labelled, calling `setAppleCalendarEnabled`. The same component takes Google and Microsoft sources, so it is used on all three pages.

Copy rules bind here: inside the dialog the word "sync" is banned, so the row is "Meetings from Apple Calendar" with "Meetings you have with people land on their timelines", and the picker's heading is "Calendars to read". The connect form needs a link to appleid.apple.com and a one-line explanation that Apple requires an app-specific password — phrase it without the word "token".

- [ ] **Step 5: Adjust the ICS panel's copy**

In `calendar-subscribe-panel.tsx`, add a line pointing Apple users at the account connection first. This file lives on `/imports`, so its existing wording ("ICS", "sync") is fine and stays.

- [ ] **Step 6: Run the tests and verify in the browser**

Run: `npx tsx scripts/run-smoke.ts --only smoke-settings-layout --only smoke-toast-copy`
Expected: PASS.

Run: `npx tsc --noEmit`, `npx eslint` — clean.

Start the dev server for this worktree on its own port (check for an existing server first — a second `next dev` sharing one `.next` wedges it), open `/settings?integration=apple`, and **front the Browser pane tab**: a hidden tab never hydrates, so probes pass vacuously.

Verify: the page renders with a connect form; the form does not submit empty; a wrong password shows an inline error rather than a toast digest; the nav row and Overview card appear with the right dot.

**Do not type a real Apple password.** Use an obviously fake one to exercise the failure path. The real credential goes in during Task 11, entered by Jason.

- [ ] **Step 7: Commit**

```bash
git add src/components/settings src/lib/integration-status.ts src/lib/data-categories.ts src/actions/integrations.ts src/components/imports/calendar-subscribe-panel.tsx scripts/smoke-settings-layout.ts
git commit -m "Add Apple to the account pages, and let people pick their calendars"
```

---

### Task 11: Live verification on a real iCloud account

**Files:**
- Modify: `docs/superpowers/specs/2026-09-22-icloud-caldav-findings.md` (a "what actually happened" section)

**This task is Jason's to drive.** Claude never types the app-specific password.

- [ ] **Step 1: Prepare a clean run**

Stop any other dev server on this worktree, start one, and confirm `ORBIT_DEMO_DATA` is off so the workspace is not auto-seeded over.

- [ ] **Step 2: Jason connects his account**

He opens `/settings?integration=apple`, generates an app-specific password at appleid.apple.com, and enters it. Claude watches the server logs and the resulting rows.

- [ ] **Step 3: Verify the first sync**

Confirm, by reading the database and logs rather than by asking: one `apple_connections` row with a home URL and `next_sync_at` set; one `calendar_sources` row per calendar with the expected `enabled` flags; after a sync pass, interactions with source `apple_calendar`; a recurring meeting producing several interactions with `cal:<uid>_<instant>` ids; a meeting present in both Google and iCloud producing exactly **one** interaction, not two.

- [ ] **Step 4: Verify the failure path**

Jason revokes the app-specific password at Apple. The next pass must disarm the connection and raise `connection.apple_calendar`, not burn six retries.

- [ ] **Step 5: Record what happened and commit**

```bash
git add docs/superpowers/specs/2026-09-22-icloud-caldav-findings.md
git commit -m "Record the first real iCloud sync"
```

---

## Self-review

**Spec coverage:** `icloud_connections` → Task 4. `calendar_sources` + migration → Tasks 4 and 7. CalDAV client + `fast-xml-parser` + host pinning → Task 5. Connect flow → Task 8. Incremental sync + ctag fallback → Tasks 5 and 6. Spike → Task 1. Recurrence + shared with ICS + occurrence ids → Tasks 2 and 3. Scheduling fan-out → Task 7. Ingestion via `ingestEvents` → Task 7. 401 disarm → Tasks 7 and 11. Outlook parity (embeddings, alerts, discovery) → Task 9. UI + picker + ICS copy → Task 10. Testing → every task. Live verification → Task 11. Free-for-all-accounts → Task 8 Step 1's assertion and Task 8 Step 3's `requireUserId`.

**Deliberately not covered, per the spec:** the ICS path's automatic two-day follow-up reminders, which the API paths do not create. That inconsistency is settled in sub-project 2.

**Open item carried into execution:** Task 7 Step 3 names two ways to reconcile `apple_connections` with the shared claim SQL's `scopes` column. The executor picks one and writes the reason in a comment; both work, and the choice is not worth blocking on.
