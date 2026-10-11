# Sprint C — audience features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-tap follow-ups with shared presets and intents, keep-in-touch cadences that actually come due, alumni/target filters, three profile fields that feed ranking and drafts, and one score vocabulary.

**Architecture:**
- **Every rule lives in one pure module, and consumers call it:**
  - `follow-up-presets.ts`: presets and date validation;
  - `keep-in-touch.ts`: effective cadence and when it falls due;
  - `contact-cadence-sql.ts`: the cadence rule's SQL twin;
  - `school-name.ts`: the school normaliser;
  - `score-labels.ts`: every score name.
- **Preset dates** are resolved in the browser's time zone and travel to the server as ISO instants. The server validates them, then stores them through the existing write paths, which now accept a `Date` as well as a day count.
- **Cadence-due** is decided by one predicate with a TS form and a SQL form. A parity smoke keeps the two identical.

**Tech Stack:** Next.js 16 App Router, React 19, Server Actions, Drizzle on PGlite/Neon, Tailwind v4, date-fns 4 (already installed; no new dependencies).

**Spec:** `docs/superpowers/specs/2026-10-11-sprint-c-audience-design.md`

## Global Constraints

- **Repo:** worktree `/Users/jasonpereira/Projects/claude-worktrees/orbit/sprint-c-audience`, branch `claude/sprint-c-audience`.
  - Commit after each task. Don't push or open a PR unless Jason asks.
  - Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Next.js:** this is Next.js 16 with breaking changes. Read the relevant guide in `node_modules/next/dist/docs/` before touching routing or server-action APIs.
  - If `npx tsc --noEmit` fails on untouched code, run `npm ci` in the worktree first.
- **Tests:**
  - Tests are `scripts/smoke-*.ts`, registered in the `MANIFEST` of `scripts/run-smoke.ts` as `"pure"` or `"pglite"`.
  - A pglite smoke's first line is `import "./smoke/_env";`.
  - The pglite tier shares one DB, so any shared state a smoke changes is restored in `cleanup()`.
  - An unregistered smoke fails `run-smoke --check`.
- **`smoke-behavior-golden`:** re-record (`--update`) only where a change is intended, and name it in the commit message.
- **Schema:** one change, at version **153**.
  - Remote refs top out at 151, and the unpushed `calendar-events-p0` worktree already claims 152.
  - Re-scan before bumping: `git for-each-ref refs/remotes`, then grep `export const SCHEMA_VERSION` on each ref, plus `../*/src/db/index.ts`.
  - Never run `db:push`. Never set `DATABASE_URL` for smokes, because it makes them hit Neon.
- **Copy:** no trailing period on short UI copy, curly apostrophes (’), at most one " — " per string.
- **Tailwind:** no Tailwind class names in code comments. Device switches are `md:` classes, never `useIsMobile`.
- **Server actions:** `"use server"` files export only async functions. Constants and types go in lib files.
- **One source of truth for each rule:**
  - presets: `src/lib/follow-up-presets.ts`;
  - effective cadence: `src/lib/keep-in-touch.ts`, plus `src/lib/contact-cadence-sql.ts`;
  - school matching: `src/lib/school-name.ts`;
  - score labels: `src/lib/score-labels.ts`.
- **`smoke-provider-exhaustive`** has a line-keyed allowlist. Re-run it after shifting lines in any listed file, and re-key any drift.
- **Before every commit:** `npx tsc --noEmit`, plus `npx eslint` on the touched files, with 0 errors.
- **Implementers never start a dev server or a browser.** The controller does the browser check in Task 12.

## Review Focus

1. **Week boundary.**
   - "Next business day" picked late on Friday, or on Saturday or Sunday, books Monday at 09:00 local.
   - "Next week" picked on a Sunday books the next day, not 8 days out.
   - Covered by the table tests in Task 1.
2. **DST.** A preset that crosses the November 2026 or March 2027 change in America/New_York keeps the same wall-clock time (1d/2d/2w) or stays at 09:00 local. It is never an hour off. Covered by Task 1.
3. **Old queued snoozes.** Offline snoozes queued before this release, with a numeric `days` arg, still replay; new ones carry an ISO date. Covered by `smoke-offline-queue` in Task 2.
4. **No double counting.**
   - A contact with a lapsed cadence and a scheduled future follow-up is not due.
   - A contact with a due follow-up and a lapsed cadence appears once.
   - A cadence-due contact never shows twice across the Due follow-ups card and the Reminders card.
   - Covered by `smoke-contact-cadence` in Task 5 and the dashboard parity case in Task 6.
5. **Empty settings.**
   - With no saved schools or targets, the Alumni and Target filters are disabled with a Settings hint, and never return the whole list.
   - A crafted URL `?alumni=1` with no schools returns zero rows, not everyone.
   - Covered by `smoke-audience-filters` in Task 8.

---

### Task 1: Shared follow-up presets and date validation (pure)

**Files:**
- Create: `src/lib/follow-up-presets.ts`
- Create: `scripts/smoke-follow-up-presets.ts`
- Modify: `scripts/run-smoke.ts`. Add `"smoke-follow-up-presets": "pure",` to the MANIFEST next to `"smoke-reminder-due-bucket": "pure",` (near line 142).

**Interfaces:**
- Consumes: `ymdInZone(d: Date, tz: string): string`, `addDaysYmd(ymd: string, n: number): string` and `weekdayOfYmd(ymd: string): number` (0 = Sunday), all from `src/lib/reminder-due-bucket.ts`.
- Produces:
  - `type FollowUpPresetId = "1d" | "2d" | "next-business-day" | "next-business-week" | "2w"`
  - `FOLLOW_UP_PRESETS: readonly { id: FollowUpPresetId; label: string; short: string }[]`, in the order 1d, 2d, next-business-day, next-business-week, 2w
  - `resolvePreset(id: FollowUpPresetId, now: Date, timeZone: string): Date`
  - `browserTimeZone(): string`
  - `validateFollowUpDate(iso: unknown, now: Date): { ok: true; date: Date } | { ok: false; message: string }`
  - `followUpSetMessage(due: Date): string`

- [ ] **Step 1: Write the failing smoke** `scripts/smoke-follow-up-presets.ts`:

```ts
/**
 * Pins `src/lib/follow-up-presets.ts`: every preset on every weekday, around 9 am, across the
 * America/New_York DST changes, and the server-side date validation.
 * Pure: pinned instants, no database.
 * Run: npx tsx scripts/smoke-follow-up-presets.ts
 */
import {
  FOLLOW_UP_PRESETS,
  resolvePreset,
  validateFollowUpDate,
  type FollowUpPresetId,
} from "../src/lib/follow-up-presets";

let failures = 0;
function eq<T>(label: string, got: T, want: T) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  }
}

const NY = "America/New_York";
/** Local wall time in `tz`, as "YYYY-MM-DD HH:mm". */
function wall(d: Date, tz: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(d).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
const at = (id: FollowUpPresetId, iso: string, tz = NY) => wall(resolvePreset(id, new Date(iso), tz), tz);

console.log("order and labels");
eq("ids", FOLLOW_UP_PRESETS.map((p) => p.id), ["1d", "2d", "next-business-day", "next-business-week", "2w"]);
eq("labels", FOLLOW_UP_PRESETS.map((p) => p.label), ["1 day", "2 days", "Next business day", "Next week", "2 weeks"]);
eq("short", FOLLOW_UP_PRESETS.map((p) => p.short), ["1d", "2d", "Next day", "Next wk", "2w"]);

// Week of Mon 2026-10-12 … Sun 2026-10-18 (EDT, UTC-4). 15:30 local = 19:30Z.
const WEEK: [string, string][] = [
  ["Mon", "2026-10-12T19:30:00Z"], ["Tue", "2026-10-13T19:30:00Z"], ["Wed", "2026-10-14T19:30:00Z"],
  ["Thu", "2026-10-15T19:30:00Z"], ["Fri", "2026-10-16T19:30:00Z"], ["Sat", "2026-10-17T19:30:00Z"],
  ["Sun", "2026-10-18T19:30:00Z"],
];
const NEXT_BIZ = ["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-19", "2026-10-19"];
const NEXT_WEEK = ["2026-10-19", "2026-10-19", "2026-10-19", "2026-10-19", "2026-10-19", "2026-10-19", "2026-10-19"];

console.log("every weekday");
WEEK.forEach(([day, iso], i) => {
  eq(`${day} 1d keeps the time`, at("1d", iso).slice(11), "15:30");
  eq(`${day} next business day`, at("next-business-day", iso), `${NEXT_BIZ[i]} 09:00`);
  eq(`${day} next week`, at("next-business-week", iso), `${NEXT_WEEK[i]} 09:00`);
});
eq("Mon next week is 7 days later", at("next-business-week", "2026-10-12T13:00:00Z"), "2026-10-19 09:00");
eq("Sun next week is tomorrow", at("next-business-week", "2026-10-18T13:00:00Z"), "2026-10-19 09:00");

console.log("around 9 am");
eq("Tue 08:59 next business day is Wed", at("next-business-day", "2026-10-13T12:59:00Z"), "2026-10-14 09:00");
eq("Tue 09:01 next business day is Wed", at("next-business-day", "2026-10-13T13:01:00Z"), "2026-10-14 09:00");
eq("Fri 23:59 local is still Friday", at("next-business-day", "2026-10-17T03:59:00Z"), "2026-10-19 09:00");

console.log("calendar-day presets");
eq("2d", at("2d", "2026-10-13T19:30:00Z"), "2026-10-15 15:30");
eq("2w", at("2w", "2026-10-13T19:30:00Z"), "2026-10-27 15:30");

console.log("DST, America/New_York");
// Fall back Sun 2026-11-01 02:00 EDT -> 01:00 EST.
eq("1d across fall-back keeps wall time", at("1d", "2026-10-31T19:30:00Z"), "2026-11-01 15:30");
eq("2w across fall-back keeps wall time", at("2w", "2026-10-25T19:30:00Z"), "2026-11-08 15:30");
eq("next week across fall-back is 09:00 EST", at("next-business-week", "2026-10-30T19:30:00Z"), "2026-11-02 09:00");
eq("next week 09:00 EST is 14:00Z", resolvePreset("next-business-week", new Date("2026-10-30T19:30:00Z"), NY).toISOString(), "2026-11-02T14:00:00.000Z");
// Spring forward Sun 2027-03-14 02:00 EST -> 03:00 EDT.
eq("1d across spring-forward keeps wall time", at("1d", "2027-03-13T20:30:00Z"), "2027-03-14 15:30");
eq("next business day after spring-forward is 13:00Z", resolvePreset("next-business-day", new Date("2027-03-12T20:30:00Z"), NY).toISOString(), "2027-03-15T13:00:00.000Z");

console.log("other zones");
eq("UTC next business day", at("next-business-day", "2026-10-16T10:00:00Z", "UTC"), "2026-10-19 09:00");
eq("Tokyo Saturday morning is Monday", at("next-business-day", "2026-10-16T23:00:00Z", "Asia/Tokyo"), "2026-10-19 09:00");

console.log("validateFollowUpDate");
const NOW = new Date("2026-10-13T19:30:00Z");
eq("future accepted", validateFollowUpDate("2026-10-14T13:00:00.000Z", NOW).ok, true);
eq("now refused", validateFollowUpDate(NOW.toISOString(), NOW).ok, false);
eq("past refused", validateFollowUpDate("2026-10-12T13:00:00.000Z", NOW).ok, false);
eq("366 days accepted", validateFollowUpDate(new Date(NOW.getTime() + 366 * 86_400_000).toISOString(), NOW).ok, true);
eq("367 days refused", validateFollowUpDate(new Date(NOW.getTime() + 367 * 86_400_000).toISOString(), NOW).ok, false);
eq("garbage refused", validateFollowUpDate("tomorrow", NOW).ok, false);
eq("number refused", validateFollowUpDate(7, NOW).ok, false);
const bad = validateFollowUpDate("2026-10-12T13:00:00.000Z", NOW);
eq("refusal copy", bad.ok ? "" : bad.message, "Pick a time in the future");

if (failures) {
  console.error(`\n${failures} follow-up preset check(s) failed`);
  process.exit(1);
}
console.log("\nall follow-up preset checks passed");
process.exit(0);
```

- [ ] **Step 2: Run it and confirm it fails.** Run `npx tsx scripts/smoke-follow-up-presets.ts`. Expected: FAIL with "Cannot find module '../src/lib/follow-up-presets'".

- [ ] **Step 3: Implement** `src/lib/follow-up-presets.ts`:

```ts
/**
 * The one set of quick follow-up choices: contact page, "Remind in" chips, Radar's schedule
 * menu and the bell's snooze. Resolved in the browser's time zone; the server only ever sees
 * the absolute instant, and checks it with `validateFollowUpDate`.
 *
 * Business days are Monday to Friday. Holidays are not skipped.
 * Pure and client-safe: no database, no Node APIs.
 */
import { format } from "date-fns";
import { addDaysYmd, weekdayOfYmd, ymdInZone } from "@/lib/reminder-due-bucket";

export type FollowUpPresetId = "1d" | "2d" | "next-business-day" | "next-business-week" | "2w";

export const FOLLOW_UP_PRESETS: readonly { id: FollowUpPresetId; label: string; short: string }[] = [
  { id: "1d", label: "1 day", short: "1d" },
  { id: "2d", label: "2 days", short: "2d" },
  { id: "next-business-day", label: "Next business day", short: "Next day" },
  { id: "next-business-week", label: "Next week", short: "Next wk" },
  { id: "2w", label: "2 weeks", short: "2w" },
];

const MAX_DAYS_AHEAD = 366;
const DAY_MS = 86_400_000;

const wallFormatters = new Map<string, Intl.DateTimeFormat>();
function wallParts(d: Date, tz: string) {
  let fmt = wallFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    wallFormatters.set(tz, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { h: Number(p.hour), m: Number(p.minute), s: Number(p.second) };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Milliseconds `tz` is ahead of UTC at instant `t`. */
function offsetAt(t: number, tz: string): number {
  const d = new Date(t);
  const ymd = ymdInZone(d, tz);
  const { h, m, s } = wallParts(d, tz);
  const asUtc = Date.parse(`${ymd}T${pad(h)}:${pad(m)}:${pad(s)}Z`);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** The instant that reads `ymd hh:mm:ss` on a wall clock in `tz`. */
function zonedInstant(ymd: string, h: number, m: number, s: number, tz: string): Date {
  const guess = Date.parse(`${ymd}T${pad(h)}:${pad(m)}:${pad(s)}Z`);
  let t = guess - offsetAt(guess, tz);
  // Second pass settles instants whose offset differs from the guess's (DST days).
  t = guess - offsetAt(t, tz);
  return new Date(t);
}

export function resolvePreset(id: FollowUpPresetId, now: Date, timeZone: string): Date {
  const today = ymdInZone(now, timeZone);
  if (id === "1d" || id === "2d" || id === "2w") {
    const days = id === "1d" ? 1 : id === "2d" ? 2 : 14;
    const { h, m, s } = wallParts(now, timeZone);
    return zonedInstant(addDaysYmd(today, days), h, m, s, timeZone);
  }
  const w = weekdayOfYmd(today);
  const ahead =
    id === "next-business-day"
      ? w === 5 ? 3 : w === 6 ? 2 : 1
      : (8 - w) % 7 || 7;
  return zonedInstant(addDaysYmd(today, ahead), 9, 0, 0, timeZone);
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Server side: the ISO instant a preset produced must be in the future and within a year. */
export function validateFollowUpDate(
  iso: unknown,
  now: Date
): { ok: true; date: Date } | { ok: false; message: string } {
  if (typeof iso !== "string" || iso.length > 40) return { ok: false, message: "Pick a time in the future" };
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.getTime() <= now.getTime()) {
    return { ok: false, message: "Pick a time in the future" };
  }
  if (date.getTime() - now.getTime() > MAX_DAYS_AHEAD * DAY_MS) {
    return { ok: false, message: "Pick a time within the next year" };
  }
  return { ok: true, date };
}

/** Toast copy once a follow-up is booked, in the viewer's own clock. */
export function followUpSetMessage(due: Date): string {
  return `Follow-up set for ${format(due, "EEE MMM d, h:mm a")}`;
}
```

- [ ] **Step 4: Run it and confirm it passes.** Run `npx tsx scripts/smoke-follow-up-presets.ts`. Expected: `all follow-up preset checks passed`. If a DST row fails, fix `zonedInstant`, not the test.

- [ ] **Step 5: Register and commit.** Add the MANIFEST line and run `npx tsx scripts/run-smoke.ts --check`, then:

```bash
git add src/lib/follow-up-presets.ts scripts/smoke-follow-up-presets.ts scripts/run-smoke.ts
git commit -m "feat(follow-up): shared preset set resolved in the browser time zone

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Server paths accept an absolute follow-up date

**Files:**
- Modify: `src/lib/reminder-writes.ts:101-130` (`scheduleContactFollowUpForUser`)
- Modify: `src/actions/reminders.ts:560-568` (`scheduleContactFollowUp`) and `:826` (`snoozeReminderAction`)
- Modify: `src/lib/radar/actions-core.ts:18-40`. Remove `SCHEDULE_DAYS`/`ScheduleDays`; `scheduleRecommendationForUser` takes `when`.
- Modify: `src/actions/radar.ts:19-23,84-92` (`scheduleFromRecommendation`)
- Modify: `src/lib/offline-queue.ts:29,93-100` and `src/lib/offline-actions.ts:24`
- Test: `scripts/smoke-follow-up-actions.ts`, `scripts/smoke-offline-queue.ts`, `scripts/smoke-radar-run.ts`

**Interfaces:**
- Consumes: `validateFollowUpDate` (Task 1).
- Produces:
  - `scheduleContactFollowUpForUser(userId: string, contactId: string, when: number | Date = 7)`. A number keeps today's 1..90-day clamp; a `Date` is used as is.
  - Server action `scheduleContactFollowUp(contactId: string, when: number | string = 7)`.
    - A string is an ISO instant, validated; an invalid one throws `UserFacingError(message)`.
    - The return shape is unchanged: `{ reminder, dueDate: string, days }`, where `days` is the number of whole days ahead.
  - Server action `snoozeReminderAction(id: string, when: number | string = 7)`. A string goes through `validateFollowUpDate` and then `snoozeReminderTo`.
  - `scheduleRecommendationForUser(userId: string, id: string, when: number | Date)`
  - Server action `scheduleFromRecommendation(id: string, dueIso: string): Promise<RadarActionResult>`
  - The offline queue's `"reminder.snooze"` args become `[reminderId: string, when: number | string]`.

- [ ] **Step 1: Write the failing tests.** Append the block below to `scripts/smoke-follow-up-actions.ts`, before its cleanup/exit. Reuse the file's existing `check` helper and a seeded contact, the same way the `booked` case near line 177 does:

```ts
// Absolute instants from the shared presets.
{
  const target = new Date(Date.now() + 3 * 86_400_000);
  target.setUTCHours(13, 0, 0, 0);
  const res = await scheduleContactFollowUp(booked.id, target.toISOString());
  check("an ISO instant books exactly that instant", res.dueDate === target.toISOString());
  let refused = "";
  try { await scheduleContactFollowUp(booked.id, new Date(Date.now() - 60_000).toISOString()); }
  catch (err) { refused = (err as Error).message; }
  check("a past instant is refused with friendly copy", refused === "Pick a time in the future");
  const legacy = await scheduleContactFollowUp(booked.id, 2);
  check("a day count still works", Math.round((new Date(legacy.dueDate).getTime() - Date.now()) / 86_400_000) === 2);
}
```

In `scripts/smoke-offline-queue.ts`, next to the `[R1, 9999]` refusal near line 130, add the checks below. Use the names the file already uses (`check`, `ok`, `R1`):

```ts
check("an ISO snooze target survives sanitising",
  sanitizeQueuedAction({ ...ok, kind: "reminder.snooze", args: [R1, "2026-10-19T13:00:00.000Z"] })?.args[1] === "2026-10-19T13:00:00.000Z");
check("a non-date string is dropped",
  sanitizeQueuedAction({ ...ok, kind: "reminder.snooze", args: [R1, "soon"] }) === null);
check("a legacy day count still replays",
  sanitizeQueuedAction({ ...ok, kind: "reminder.snooze", args: [R1, 7] })?.args[1] === 7);
```

- [ ] **Step 2: Run both and confirm they fail.** Run `npx tsx scripts/smoke-follow-up-actions.ts` and `npx tsx scripts/smoke-offline-queue.ts`. Expected: type errors or FAIL on the new checks, because a string is not assignable to `days: number`.

- [ ] **Step 3: Implement the lib function.** In `src/lib/reminder-writes.ts`, change the signature and the due computation. Update the doc comment's first line to say `when` is "a day count (clamped 1..90) or an exact instant".

```ts
export async function scheduleContactFollowUpForUser(
  userId: string,
  contactId: string,
  when: number | Date = 7
) {
```

```ts
  const due =
    when instanceof Date
      ? new Date(when.getTime())
      : (() => {
          const d = new Date();
          d.setDate(d.getDate() + Math.max(1, Math.min(90, when)));
          return d;
        })();
```

Then set the returned `days` field to `Math.max(1, Math.round((due.getTime() - Date.now()) / 86_400_000))`. Read how `days` is returned today and keep the key name.

- [ ] **Step 4: Implement the actions** in `src/actions/reminders.ts`:

```ts
export async function scheduleContactFollowUp(
  contactId: string,
  when: number | string = 7
) {
  const userId = await requireUserId();
  let target: number | Date = typeof when === "number" ? when : 7;
  if (typeof when === "string") {
    const checked = validateFollowUpDate(when, new Date());
    if (!checked.ok) throw new UserFacingError(checked.message);
    target = checked.date;
  }
  const result = await scheduleContactFollowUpForUser(userId, contactId, target);
  revalidateReminderPaths(contactId);
  revalidatePathIfRequestScoped("/contacts");
  return result;
}
```

```ts
export async function snoozeReminderAction(id: string, when: number | string = 7) {
  const userId = await requireUserId();
  let snapshot;
  if (typeof when === "string") {
    const checked = validateFollowUpDate(when, new Date());
    if (!checked.ok) throw new UserFacingError(checked.message);
    snapshot = await snoozeReminderTo(userId, id, checked.date);
  } else {
    snapshot = await snoozeReminder(userId, id, when);
  }
  revalidateReminderPaths();
  revalidatePathIfRequestScoped("/contacts");
  revalidatePathIfRequestScoped("/graph");
  // Handed back so the toast can offer Undo; see `unsnoozeReminderAction`.
  return snapshot;
}
```

Imports:
- `validateFollowUpDate` from `@/lib/follow-up-presets`.
- `snoozeReminderTo` from `@/lib/reminders`.
- `UserFacingError`: find it with `grep -rn "class UserFacingError" src/lib`. It is the friendly-error convention; never leak `err.message` from anything else. If the file already imports it, reuse that import.

- [ ] **Step 5: Implement Radar.**
  - In `src/lib/radar/actions-core.ts`, delete the `SCHEDULE_DAYS` and `ScheduleDays` lines. Change the signature to `scheduleRecommendationForUser(userId: string, id: string, when: number | Date)` and pass `when` through.
  - In `src/actions/radar.ts`, drop those two imports and change the action:

```ts
export async function scheduleFromRecommendation(id: string, dueIso: string): Promise<RadarActionResult> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  const checked = validateFollowUpDate(dueIso, new Date());
  if (!checked.ok) return { ok: false, message: checked.message };
  const result = await scheduleRecommendationForUser(userId, id, checked.date);
```

(The rest of the function body is unchanged.)

- [ ] **Step 6: Implement the offline queue.** In `src/lib/offline-queue.ts`, set the arg type to `"reminder.snooze": [reminderId: string, when: number | string];` and replace the days check in the sanitiser:

```ts
    case "reminder.snooze": {
      const [reminderId, when] = v.args;
      if (typeof reminderId !== "string" || !ID_RE.test(reminderId)) return null;
      const dayCount = typeof when === "number" && Number.isInteger(when) && when >= 1 && when <= 90;
      const instant = typeof when === "string" && when.length <= 40 && !Number.isNaN(Date.parse(when));
      if (!dayCount && !instant) return null;
      return { ...base, kind: "reminder.snooze", args: [reminderId, when] };
    }
```

In `src/lib/offline-actions.ts:24`, rename `days` to `when`. The server re-validates on replay, so a queued instant that has since passed fails with the friendly copy.

- [ ] **Step 7: Fix callers that type-check against the old names.**
  - Run `npx tsc --noEmit`.
  - `src/components/radar/use-recommendation-actions.ts:78-82` still passes `3 | 7 | 14`. For now, change its param to `dueIso: string` and pass it straight through; Task 3 rewrites it.
  - `scripts/smoke-radar-run.ts:449,455` and `scripts/smoke-radar-metrics.ts:109` pass `7`. That still type-checks, because `when` is `number | Date`.

- [ ] **Step 8: Run the tests and confirm they pass.** Run `npx tsx scripts/smoke-follow-up-actions.ts`, `npx tsx scripts/smoke-offline-queue.ts`, `npx tsx scripts/smoke-radar-run.ts`, `npx tsx scripts/smoke-toast-undo.ts` and `npx tsx scripts/smoke-radar-metrics.ts`. Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/lib/reminder-writes.ts src/actions/reminders.ts src/lib/radar/actions-core.ts src/actions/radar.ts src/lib/offline-queue.ts src/lib/offline-actions.ts src/components/radar/use-recommendation-actions.ts scripts/smoke-follow-up-actions.ts scripts/smoke-offline-queue.ts
git commit -m "feat(follow-up): schedule and snooze accept a validated absolute date

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Switch the four surfaces to the shared presets

**Files:**
- Modify: `src/components/contacts/contact-follow-up-section.tsx`: `:54-58` (delete `REMIND_PRESETS`), `:127-144` (`scheduleDays` → `schedulePreset`), `:309-321` (chips)
- Modify: `src/components/follow-up/easy-follow-up.tsx`: `:19-23` (delete `PRESETS`), `:81-99`, `:156-173`
- Modify: `src/components/radar/use-recommendation-actions.ts:78-90` and `src/components/radar/recommendation-card.tsx:95,264-275`
- Modify: `src/components/notifications/notifications-panel.tsx:174-186,326-329,718-728`
- Create: `scripts/smoke-follow-up-preset-surfaces.ts` (pure source scan)
- Modify: `scripts/run-smoke.ts` (register `"smoke-follow-up-preset-surfaces": "pure"`)

`src/components/reminders/reminder-done-snooze.tsx` is deliberately unchanged. It stays a fixed 7-day snooze, like the Reminders page's own menu.

**Interfaces:**
- Consumes: `FOLLOW_UP_PRESETS`, `resolvePreset`, `browserTimeZone` and `followUpSetMessage` (Task 1), and the Task 2 actions with an ISO string.
- Produces: no new exports. The UI calls `scheduleContactFollowUp(id, iso)`, `scheduleFromRecommendation(recId, iso)` and `snoozeReminderAction(id, iso)`.

- [ ] **Step 1: Write the failing source-scan smoke** `scripts/smoke-follow-up-preset-surfaces.ts`:

```ts
/**
 * Every follow-up quick choice reads the shared preset list. Fails if a surface grows its own
 * day list again, or if one of them stops importing the shared module.
 * Pure: reads source files.
 * Run: npx tsx scripts/smoke-follow-up-preset-surfaces.ts
 */
import { readFileSync } from "node:fs";

const SURFACES = [
  "src/components/contacts/contact-follow-up-section.tsx",
  "src/components/follow-up/easy-follow-up.tsx",
  "src/components/radar/recommendation-card.tsx",
  "src/components/notifications/notifications-panel.tsx",
];
let failures = 0;
for (const file of SURFACES) {
  const src = readFileSync(file, "utf8");
  if (!src.includes("@/lib/follow-up-presets")) { failures++; console.error(`  FAIL ${file} does not import the shared presets`); }
  if (/\{\s*days:\s*\d+,\s*label:/.test(src)) { failures++; console.error(`  FAIL ${file} defines its own day presets`); }
  if (/schedule\((3|7|14)\)/.test(src)) { failures++; console.error(`  FAIL ${file} hard-codes a schedule day count`); }
  if (/snoozeReminderAction\([^,]+,\s*7\)/.test(src)) { failures++; console.error(`  FAIL ${file} hard-codes a 7-day snooze`); }
}
for (const gone of ["SCHEDULE_DAYS", "REMIND_PRESETS"]) {
  for (const file of [...SURFACES, "src/lib/radar/actions-core.ts", "src/actions/radar.ts"]) {
    if (readFileSync(file, "utf8").includes(gone)) { failures++; console.error(`  FAIL ${file} still names ${gone}`); }
  }
}
if (failures) { console.error(`\n${failures} preset surface check(s) failed`); process.exit(1); }
console.log("all preset surface checks passed");
process.exit(0);
```

- [ ] **Step 2: Run it and confirm it fails.** Run `npx tsx scripts/smoke-follow-up-preset-surfaces.ts`. Expected: FAIL on all four surfaces.

- [ ] **Step 3: Contact page chips.** In `contact-follow-up-section.tsx`, delete `REMIND_PRESETS` and replace `scheduleDays(days: number)` with the version below. Keep the existing `start`/`setScheduling`/error handling around the call exactly as it is; only the call and the toast text change.

```ts
  function schedulePreset(id: FollowUpPresetId) {
    const due = resolvePreset(id, new Date(), browserTimeZone());
    // …existing pending/toast wrapper…
    await scheduleContactFollowUp(contactId, due.toISOString());
    promptNotificationsAfterFollowUpAction();
    toast.success(followUpSetMessage(due));
  }
```

Render all five chips, with the short label as the text and the long one as the title:

```tsx
{FOLLOW_UP_PRESETS.map((p) => (
  <Button key={p.id} type="button" size="sm" variant="outline" disabled={scheduling}
    className="h-8 px-2.5" title={p.label} aria-label={`Follow up in ${p.label.toLowerCase()}`}
    onClick={() => schedulePreset(p.id)}>
    {p.short}
  </Button>
))}
```

- [ ] **Step 4: EasyFollowUp.** In `easy-follow-up.tsx`:
  - Delete `PRESETS`.
  - `schedule(id: FollowUpPresetId)` resolves the date the same way and calls `scheduleContactFollowUp(contactId, due.toISOString())`. It keeps `onScheduled?.(res.dueDate)` and toasts `followUpSetMessage(due)`.
  - Render `(compact ? FOLLOW_UP_PRESETS.slice(0, 4) : FOLLOW_UP_PRESETS)` with the same Button props as today (`variant="ghost"`, `h-8 px-2.5`, `preventDefault`/`stopPropagation`). Use `p.short` as the text and `p.label` as the title. The "Remind in" label stays.

- [ ] **Step 5: Radar.**
  - In `use-recommendation-actions.ts`:
    - `const schedule = (id: FollowUpPresetId) => { const due = resolvePreset(id, new Date(), browserTimeZone()); … scheduleFromRecommendation(rec.id, due.toISOString()) … }`
    - The success toast is `followUpSetMessage(due)`.
  - In `recommendation-card.tsx:264-275`, replace the three hard-coded items:

```tsx
<DropdownMenuLabel>Follow up</DropdownMenuLabel>
{FOLLOW_UP_PRESETS.map((p) => (
  <DropdownMenuItem key={p.id} onClick={() => schedule(p.id)}>{p.label}</DropdownMenuItem>
))}
```

  - At `:95`, change the keyboard command to `if (command === "schedule") actions.schedule("next-business-week");`. Its old default was "a week", and "Next week" is the closest preset.

- [ ] **Step 6: The bell's snooze becomes a menu.** In `notifications-panel.tsx`:
  - `snooze(reminderId: string, id: FollowUpPresetId)` resolves `due` and runs `snoozeReminderAction(reminderId, due.toISOString())`.
    - Success copy: `` `Snoozed until ${format(due, "EEE MMM d, h:mm a")}` `` (import `format` from `date-fns`).
    - Keep `undo`.
    - `offline` becomes `{ kind: "reminder.snooze", args: [reminderId, due.toISOString()], subject: reminderId }`.
  - `onSnooze` becomes `(id: FollowUpPresetId) => void`. Wire it at `:326-329`: `onSnooze={(id) => { if (item.kind === "reminder" && item.reminderId) snooze(item.reminderId, id); }}`.
  - Replace the icon button at `:718-728` with a `DropdownMenu` from `@/components/ui/dropdown-menu`, following `recommendation-card.tsx:264` for the trigger idiom. Keep the same icon button as the trigger:

```tsx
<DropdownMenu>
  <DropdownMenuTrigger render={<Button size="icon" variant="ghost" className={ICON_BTN} disabled={pending} aria-label="Snooze" title="Snooze" />}>
    <Clock className="h-3.5 w-3.5" />
  </DropdownMenuTrigger>
  <DropdownMenuContent align="end">
    <DropdownMenuLabel>Snooze until</DropdownMenuLabel>
    {FOLLOW_UP_PRESETS.map((p) => (
      <DropdownMenuItem key={p.id} onClick={() => onSnooze(p.id)}>{p.label}</DropdownMenuItem>
    ))}
  </DropdownMenuContent>
</DropdownMenu>
```

Copy the exact `DropdownMenuTrigger` prop pattern (`render=` or `asChild`) from `recommendation-card.tsx`; don't guess.

- [ ] **Step 7: Run the tests and confirm they pass.** Run:
  - `npx tsx scripts/smoke-follow-up-preset-surfaces.ts`
  - `npx tsx scripts/smoke-offline-queue.ts`
  - `npx tsc --noEmit`
  - `npx eslint src/components/contacts/contact-follow-up-section.tsx src/components/follow-up/easy-follow-up.tsx src/components/radar src/components/notifications`

  Expected: pass, 0 errors.

- [ ] **Step 8: Register and commit**

```bash
git add src/components scripts/smoke-follow-up-preset-surfaces.ts scripts/run-smoke.ts
git commit -m "feat(follow-up): contact, Remind in, Radar and bell share one preset menu

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Follow-up intent chips

**Files:**
- Create: `src/lib/follow-up-intents.ts`
- Modify: `src/components/contacts/contact-follow-up-section.tsx:396-408` (intent field) and `:182-203` (`draftFor`)
- Modify: `src/components/follow-up/follow-up-draft-sheet.tsx:35,52,71-130,~200` (intent state and chips)
- Create: `scripts/smoke-follow-up-intents.ts`
- Modify: `scripts/run-smoke.ts` (register `"smoke-follow-up-intents": "pure"`)

**Interfaces:**
- Consumes: `draftContactFollowUp(contactId, { channel?, intent?, reuse? })` (`src/actions/contacts.ts:1412`, unchanged).
- Produces: `FOLLOW_UP_INTENTS: readonly { id: "thanks" | "referral" | "informational" | "keep-in-mind"; label: string; instruction: string }[]`.

- [ ] **Step 1: Write the failing smoke** `scripts/smoke-follow-up-intents.ts`:

```ts
/**
 * Pins the four follow-up intent chips (labels and the exact instruction copy), and that both
 * draft surfaces render them with the intent field always visible.
 * Run: npx tsx scripts/smoke-follow-up-intents.ts
 */
import { readFileSync } from "node:fs";
import { FOLLOW_UP_INTENTS } from "../src/lib/follow-up-intents";

let failures = 0;
const fail = (m: string) => { failures++; console.error(`  FAIL ${m}`); };
const want = [
  ["Thank you", "Thank them for their time and mention one specific thing from our conversation"],
  ["Referral ask", "Ask if they’d be open to referring me for a role on their team, and offer to send my resume"],
  ["Informational chat", "Ask for 20 minutes to hear about their path and their team"],
  ["Keep me in mind", "A short, warm note to stay in touch and ask them to keep me in mind for future roles"],
];
if (JSON.stringify(FOLLOW_UP_INTENTS.map((i) => [i.label, i.instruction])) !== JSON.stringify(want)) fail("intent labels or copy changed");
for (const i of FOLLOW_UP_INTENTS) {
  if (/'/.test(i.instruction)) fail(`${i.label}: straight apostrophe`);
  if (/\.$/.test(i.instruction)) fail(`${i.label}: trailing period`);
}
for (const file of ["src/components/contacts/contact-follow-up-section.tsx", "src/components/follow-up/follow-up-draft-sheet.tsx"]) {
  const src = readFileSync(file, "utf8");
  if (!src.includes("FOLLOW_UP_INTENTS")) fail(`${file} does not render the intent chips`);
  if (/initialIntent \|\| intent \?/.test(src)) fail(`${file} still hides the intent field until one is set`);
}
if (failures) { console.error(`\n${failures} intent check(s) failed`); process.exit(1); }
console.log("all intent checks passed");
process.exit(0);
```

- [ ] **Step 2: Run it and confirm it fails.** Run `npx tsx scripts/smoke-follow-up-intents.ts`. Expected: FAIL with "Cannot find module '../src/lib/follow-up-intents'".

- [ ] **Step 3: Create** `src/lib/follow-up-intents.ts`:

```ts
/** One-tap reasons for a follow-up. The instruction lands in the editable intent field. */
export const FOLLOW_UP_INTENTS = [
  { id: "thanks", label: "Thank you", instruction: "Thank them for their time and mention one specific thing from our conversation" },
  { id: "referral", label: "Referral ask", instruction: "Ask if they’d be open to referring me for a role on their team, and offer to send my resume" },
  { id: "informational", label: "Informational chat", instruction: "Ask for 20 minutes to hear about their path and their team" },
  { id: "keep-in-mind", label: "Keep me in mind", instruction: "A short, warm note to stay in touch and ask them to keep me in mind for future roles" },
] as const;
```

- [ ] **Step 4: Contact page.** In `contact-follow-up-section.tsx`:
  - Change the signature to `function draftFor(p: Platform, intentOverride?: string)`. Inside it, use `const useIntent = (intentOverride ?? intent).trim();` and pass `intent: useIntent || undefined`.
  - Replace the conditional input at `:396-408` with an always-rendered chip row and input:

```tsx
<p className="mb-2 text-xs font-medium text-muted-foreground">Draft for</p>
<div className="mb-2 flex flex-wrap gap-1.5">
  {FOLLOW_UP_INTENTS.map((i) => (
    <Button key={i.id} type="button" size="sm" variant={intent === i.instruction ? "default" : "outline"}
      aria-pressed={intent === i.instruction} className="h-8 px-2.5" disabled={pending}
      onClick={() => { setIntent(i.instruction); draftFor(platform, i.instruction); }}>
      {i.label}
    </Button>
  ))}
</div>
<input type="text" value={intent} onChange={(e) => setIntent(e.target.value)}
  aria-label="What this message is for"
  placeholder="What’s this message for? (optional)"
  className="mb-2 w-full max-w-md rounded-lg border border-border/70 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-border" />
```

`platform` is the existing selected-platform state. If it can be null, fall back to the first platform the section offers; read the code for that default.

- [ ] **Step 5: Draft sheet.** In `follow-up-draft-sheet.tsx`:
  - Add `const [intentText, setIntentText] = useState(intent ?? "");`. Reset it inside the existing open effect with `setIntentText(intent ?? "")`.
  - `regenerate(next?: string)` calls `draftContactFollowUp(contactId, { intent: (next ?? intentText).trim() || undefined })`.
  - Render the same chip row and input as Step 4 between the header and the Regenerate/Generate row. Chips call `setIntentText(i.instruction); regenerate(i.instruction);`.
  - The open effect keeps using the `intent` prop, so Radar's `draftIntent(rec)` still prefills.

- [ ] **Step 6: Run the tests and confirm they pass.** Run `npx tsx scripts/smoke-follow-up-intents.ts`, then `npx tsc --noEmit` and `npx eslint` on both components. Expected: pass.

- [ ] **Step 7: Register and commit**

```bash
git add src/lib/follow-up-intents.ts src/components/contacts/contact-follow-up-section.tsx src/components/follow-up/follow-up-draft-sheet.tsx scripts/smoke-follow-up-intents.ts scripts/run-smoke.ts
git commit -m "feat(follow-up): intent field always shows, with four one-tap intents

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Effective cadence: one rule, TS and SQL

**Files:**
- Modify: `src/lib/keep-in-touch.ts`.
  - Delete `CadenceContact`, `CadenceDue`, `keepInTouchDue`, `keepInTouchDescription` and `cadenceLabel`. They are dead in `src/`; only `scripts/smoke-keep-in-touch.ts` uses them.
  - Keep `KEEP_IN_TOUCH_PRESETS`, `KeepInTouchCadence`, `KEEP_IN_TOUCH_MAX_DAYS` and `normalizeCadence`.
- Create: `src/lib/contact-cadence-sql.ts`
- Rewrite: `scripts/smoke-keep-in-touch.ts`. Drop the pure checks of the deleted helpers and keep its DB checks of `dormant_high_value` (Task 7 updates those).
- Create: `scripts/smoke-contact-cadence.ts` (pglite; TS/SQL parity)
- Modify: `scripts/run-smoke.ts` (register `"smoke-contact-cadence": "pglite"`)

**Interfaces:**
- Consumes: the `contacts` columns `cadenceDays`, `closenessTier` (`"inner" | "mid" | "outer" | null`, materialised by `closeness-materialize.ts`), `lastInteractionAt`, `dateMet`, `createdAt` and `nextFollowUpAt`.
- Produces, from `src/lib/keep-in-touch.ts` (pure):
  - `TIER_DEFAULT_CADENCE: { readonly inner: 30; readonly mid: 90; readonly outer: null }`
  - `type CadenceInput = { cadenceDays: number | null; closenessTier: "inner" | "mid" | "outer" | null; lastInteractionAt: Date | string | null; dateMet?: Date | string | null; createdAt?: Date | string | null; nextFollowUpAt: Date | string | null }`
  - `effectiveCadenceDays(c: Pick<CadenceInput, "cadenceDays" | "closenessTier">): number | null`
  - `isTierDefaultCadence(c: Pick<CadenceInput, "cadenceDays" | "closenessTier">): boolean`
  - `cadenceDueAt(c: CadenceInput): Date | null`. This is the anchor plus the effective cadence, or null. It ignores `nextFollowUpAt`.
  - `followUpDueAt(c: CadenceInput): Date | null`. This is `nextFollowUpAt` when set, otherwise `cadenceDueAt`.
  - `isFollowUpDue(c: CadenceInput, now: Date): boolean`
  - `cadenceName(days: number): string`. Returns "Monthly", "Quarterly", "Twice a year", "Yearly", "Weekly" (7), "Every 2 weeks" (14), otherwise `` `Every ${days} days` ``.
- Produces, from `src/lib/contact-cadence-sql.ts`:
  - `type CadenceColumns`
  - `contactColumns: CadenceColumns`
  - `aliasColumns(alias: string): CadenceColumns`
  - `effectiveCadenceSql(c?: CadenceColumns): SQL<number | null>`
  - `cadenceDueAtSql(c?: CadenceColumns): SQL<string | null>`
  - `followUpDueSql(now: SQL, c?: CadenceColumns): SQL<boolean>`

- [ ] **Step 1: Write the failing parity smoke** `scripts/smoke-contact-cadence.ts`.

Before writing it, open two sibling pglite smokes: `scripts/smoke-keep-in-touch.ts` and `scripts/smoke-due-follow-ups-parity.ts`. Copy how they create the smoke user and the contacts insert shape, and replace the `ensureSmokeUser` import line below with that exact pattern.

```ts
import "./smoke/_env";
/**
 * The effective-cadence rule in TypeScript (`keep-in-touch.ts`) and in SQL
 * (`contact-cadence-sql.ts`) agree, contact by contact, on a fixture covering every branch.
 * Run: npx tsx scripts/smoke-contact-cadence.ts
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import {
  cadenceDueAt, cadenceName, effectiveCadenceDays, isFollowUpDue, isTierDefaultCadence,
} from "../src/lib/keep-in-touch";
import { cadenceDueAtSql, effectiveCadenceSql, followUpDueSql } from "../src/lib/contact-cadence-sql";
import { ensureSmokeUser } from "./smoke/user"; // replace with the user-setup pattern sibling pglite smokes use

const USER = "smoke-contact-cadence";
let failures = 0;
const check = (label: string, ok: boolean) => { if (ok) console.log(`  ok   ${label}`); else { failures++; console.error(`  FAIL ${label}`); } };
const DAY = 86_400_000;
const now = new Date();
const ago = (d: number) => new Date(now.getTime() - d * DAY);
const ahead = (d: number) => new Date(now.getTime() + d * DAY);

console.log("pure rule");
check("own cadence wins", effectiveCadenceDays({ cadenceDays: 14, closenessTier: "inner" }) === 14);
check("inner defaults monthly", effectiveCadenceDays({ cadenceDays: null, closenessTier: "inner" }) === 30);
check("mid defaults quarterly", effectiveCadenceDays({ cadenceDays: null, closenessTier: "mid" }) === 90);
check("outer has none", effectiveCadenceDays({ cadenceDays: null, closenessTier: "outer" }) === null);
check("no tier has none", effectiveCadenceDays({ cadenceDays: null, closenessTier: null }) === null);
check("tier default flagged", isTierDefaultCadence({ cadenceDays: null, closenessTier: "inner" }));
check("own cadence not flagged", !isTierDefaultCadence({ cadenceDays: 30, closenessTier: "inner" }));
check("names", [30, 90, 180, 365, 7, 14, 45].map(cadenceName).join("|") === "Monthly|Quarterly|Twice a year|Yearly|Weekly|Every 2 weeks|Every 45 days");
check("future follow-up blocks cadence-due",
  !isFollowUpDue({ cadenceDays: 30, closenessTier: null, lastInteractionAt: ago(40), nextFollowUpAt: ahead(3) }, now));
check("lapsed cadence is due", isFollowUpDue({ cadenceDays: 30, closenessTier: null, lastInteractionAt: ago(31), nextFollowUpAt: null }, now));
check("unlapsed cadence is not due", !isFollowUpDue({ cadenceDays: 30, closenessTier: null, lastInteractionAt: ago(29), nextFollowUpAt: null }, now));
check("no touch falls back to date met",
  cadenceDueAt({ cadenceDays: 30, closenessTier: null, lastInteractionAt: null, dateMet: ago(10), createdAt: ago(100), nextFollowUpAt: null })!.getTime() === ago(10).getTime() + 30 * DAY);

console.log("SQL twin agrees");
const db = await getDb();
await ensureSmokeUser(USER);
const FIXTURE = [
  { fullName: "Own 30 lapsed", cadenceDays: 30, closenessTier: "outer", lastInteractionAt: ago(31) },
  { fullName: "Own 30 fresh", cadenceDays: 30, closenessTier: "outer", lastInteractionAt: ago(5) },
  { fullName: "Inner default lapsed", cadenceDays: null, closenessTier: "inner", lastInteractionAt: ago(31) },
  { fullName: "Mid default fresh", cadenceDays: null, closenessTier: "mid", lastInteractionAt: ago(60) },
  { fullName: "Outer none", cadenceDays: null, closenessTier: "outer", lastInteractionAt: ago(400) },
  { fullName: "Scheduled ahead", cadenceDays: 30, closenessTier: "inner", lastInteractionAt: ago(90), nextFollowUpAt: ahead(2) },
  { fullName: "Scheduled due", cadenceDays: 30, closenessTier: "inner", lastInteractionAt: ago(90), nextFollowUpAt: ago(1) },
  { fullName: "No touch, date met", cadenceDays: 14, closenessTier: null, lastInteractionAt: null, dateMet: ago(20) },
] as const;
const ids: string[] = [];
try {
  for (const f of FIXTURE) {
    const [row] = await db.insert(contacts).values({ userId: USER, ...f } as typeof contacts.$inferInsert).returning({ id: contacts.id });
    ids.push(row.id);
  }
  const rows = await db.select({
    id: contacts.id, fullName: contacts.fullName, cadenceDays: contacts.cadenceDays, closenessTier: contacts.closenessTier,
    lastInteractionAt: contacts.lastInteractionAt, dateMet: contacts.dateMet, createdAt: contacts.createdAt,
    nextFollowUpAt: contacts.nextFollowUpAt,
    sqlEffective: effectiveCadenceSql(), sqlDueAt: cadenceDueAtSql(), sqlDue: followUpDueSql(sql`${now.toISOString()}::timestamptz`),
  }).from(contacts).where(and(eq(contacts.userId, USER), inArray(contacts.id, ids)));
  for (const r of rows) {
    const tsDueAt = cadenceDueAt(r);
    const sqlDueAt = r.sqlDueAt ? new Date(r.sqlDueAt) : null;
    check(`${r.fullName}: effective`, Number(r.sqlEffective ?? -1) === (effectiveCadenceDays(r) ?? -1));
    check(`${r.fullName}: due-at`, (sqlDueAt?.getTime() ?? null) === (tsDueAt?.getTime() ?? null));
    check(`${r.fullName}: due`, Boolean(r.sqlDue) === isFollowUpDue(r, now));
  }
  const dueNames = rows.filter((r) => isFollowUpDue(r, now)).map((r) => r.fullName).sort();
  check("due set", JSON.stringify(dueNames) === JSON.stringify(["Inner default lapsed", "No touch, date met", "Own 30 lapsed", "Scheduled due"]));
} finally {
  if (ids.length) await db.delete(contacts).where(inArray(contacts.id, ids));
}
if (failures) { console.error(`\n${failures} cadence check(s) failed`); process.exit(1); }
console.log("\nall cadence checks passed");
process.exit(0);
```

- [ ] **Step 2: Run it and confirm it fails.** Run `npx tsx scripts/smoke-contact-cadence.ts`. Expected: FAIL on the missing exports.

- [ ] **Step 3: Implement the pure rule** in `src/lib/keep-in-touch.ts`. Delete the five dead exports, plus the `asDate`/`daysBetween` helpers if nothing else uses them. Add:

```ts
/**
 * How often to keep in touch when the person never said: closest people monthly, the middle
 * ring quarterly, everyone else not at all. Not a setting. A contact's own cadence always wins.
 */
export const TIER_DEFAULT_CADENCE = { inner: 30, mid: 90, outer: null } as const;

type Tier = "inner" | "mid" | "outer";
export type CadenceInput = {
  cadenceDays: number | null;
  closenessTier: Tier | null;
  lastInteractionAt: Date | string | null;
  dateMet?: Date | string | null;
  createdAt?: Date | string | null;
  nextFollowUpAt: Date | string | null;
};

const DAY_MS = 86_400_000;
const toDate = (v: Date | string | null | undefined): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export function effectiveCadenceDays(c: Pick<CadenceInput, "cadenceDays" | "closenessTier">): number | null {
  if (c.cadenceDays && c.cadenceDays > 0) return c.cadenceDays;
  return c.closenessTier ? TIER_DEFAULT_CADENCE[c.closenessTier] : null;
}

export function isTierDefaultCadence(c: Pick<CadenceInput, "cadenceDays" | "closenessTier">): boolean {
  return !(c.cadenceDays && c.cadenceDays > 0) && effectiveCadenceDays(c) !== null;
}

/** When the cadence lapses: last touch (else date met, else creation) plus the cadence. */
export function cadenceDueAt(c: CadenceInput): Date | null {
  const days = effectiveCadenceDays(c);
  const anchor = toDate(c.lastInteractionAt) ?? toDate(c.dateMet) ?? toDate(c.createdAt);
  return days === null || !anchor ? null : new Date(anchor.getTime() + days * DAY_MS);
}

/** A booked follow-up always decides; the cadence speaks only when nothing is booked. */
export function followUpDueAt(c: CadenceInput): Date | null {
  return toDate(c.nextFollowUpAt) ?? cadenceDueAt(c);
}

export function isFollowUpDue(c: CadenceInput, now: Date): boolean {
  const at = followUpDueAt(c);
  return at !== null && at.getTime() <= now.getTime();
}

export function cadenceName(days: number): string {
  const preset = KEEP_IN_TOUCH_PRESETS.find((p) => p.days === days);
  if (preset) return preset.label;
  if (days === 7) return "Weekly";
  if (days === 14) return "Every 2 weeks";
  return `Every ${days} days`;
}
```

- [ ] **Step 4: Implement the SQL twin** `src/lib/contact-cadence-sql.ts`:

```ts
import { sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import { contacts } from "@/db/schema";

/**
 * The SQL twin of `keep-in-touch.ts`: effective cadence, when it lapses, and "is this follow-up
 * due". `scripts/smoke-contact-cadence.ts` holds the two to the same answers.
 *
 * Intervals are 24-HOUR multiples, not `interval '1 day'`, so a session time zone with DST
 * cannot move the instant by an hour away from the TypeScript arithmetic.
 */
type Ref = AnyColumn | SQL;
export type CadenceColumns = {
  cadenceDays: Ref; closenessTier: Ref; lastInteractionAt: Ref; dateMet: Ref; createdAt: Ref; nextFollowUpAt: Ref;
};

export const contactColumns: CadenceColumns = {
  cadenceDays: contacts.cadenceDays,
  closenessTier: contacts.closenessTier,
  lastInteractionAt: contacts.lastInteractionAt,
  dateMet: contacts.dateMet,
  createdAt: contacts.createdAt,
  nextFollowUpAt: contacts.nextFollowUpAt,
};

/** For raw SQL that joins contacts under an alias (`due` in the reminders card query). */
export function aliasColumns(alias: string): CadenceColumns {
  if (!/^[a-z_]+$/.test(alias)) throw new Error("bad alias");
  const col = (name: string) => sql.raw(`${alias}.${name}`);
  return {
    cadenceDays: col("cadence_days"), closenessTier: col("closeness_tier"), lastInteractionAt: col("last_interaction_at"),
    dateMet: col("date_met"), createdAt: col("created_at"), nextFollowUpAt: col("next_follow_up_at"),
  };
}

export function effectiveCadenceSql(c: CadenceColumns = contactColumns): SQL<number | null> {
  return sql<number | null>`coalesce(
    case when ${c.cadenceDays} > 0 then ${c.cadenceDays} end,
    case ${c.closenessTier} when 'inner' then 30 when 'mid' then 90 end
  )`;
}

export function cadenceDueAtSql(c: CadenceColumns = contactColumns): SQL<string | null> {
  return sql<string | null>`(coalesce(${c.lastInteractionAt}, ${c.dateMet}, ${c.createdAt}) + ${effectiveCadenceSql(c)} * interval '24 hours')`;
}

/**
 * Due now: a booked follow-up at or before `now`, or nothing booked and the cadence lapsed.
 * Truncated to the millisecond as reminders.ts always did, so a JS Date and the column agree.
 */
export function followUpDueSql(now: SQL, c: CadenceColumns = contactColumns): SQL<boolean> {
  return sql<boolean>`(
    (${c.nextFollowUpAt} is not null and date_trunc('milliseconds', ${c.nextFollowUpAt}) <= ${now})
    or (${c.nextFollowUpAt} is null and date_trunc('milliseconds', ${cadenceDueAtSql(c)}) <= ${now})
  )`;
}
```

These fragments are used inside `db.query.contacts.findMany` `extras` in Task 6, the same way `contactHasNotesSql` is. Keep the "unqualified column" trap in mind there: a column interpolated into sql`` inside `.select()` can lose its table prefix in a join. If a join query ever yields an ambiguous-column error, pass `aliasColumns(...)` instead.

- [ ] **Step 5: Rewrite `scripts/smoke-keep-in-touch.ts`.** Delete its pure section (lines ~38-145), which imported the removed helpers. Leave the DB `dormant_high_value` checks unchanged for now.

- [ ] **Step 6: Run the tests and confirm they pass.** Run `npx tsx scripts/smoke-contact-cadence.ts`, `npx tsx scripts/smoke-keep-in-touch.ts` and `npx tsc --noEmit`. Expected: pass.

- [ ] **Step 7: Register and commit**

```bash
git add src/lib/keep-in-touch.ts src/lib/contact-cadence-sql.ts scripts/smoke-contact-cadence.ts scripts/smoke-keep-in-touch.ts scripts/run-smoke.ts
git commit -m "feat(cadence): effective cadence with tier defaults, one rule in TS and SQL

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Cadence shows, persists, and comes due everywhere

**Files:**
- Modify: `src/app/(clerk)/(app)/(main)/contacts/[id]/page.tsx:403-411,497-515` (audit C5: pass the cadence)
- Modify: `src/components/contacts/contact-follow-up-section.tsx:75-97,111,359-394` (show the effective cadence and the tier default)
- Modify: `src/lib/contacts-page-query.ts`: `:131-135` (`followUp=due`) and the list select (`:51-200`)
- Modify: `src/lib/contacts-page.ts:114-148` (`ContactListRow.keepInTouchDays`)
- Modify: `src/components/contacts/contacts-list.tsx` (`ContactListItem` type ~72-97; row tag ~733-756)
- Modify: `src/lib/dashboard-aggregates.ts:~100` (the `due` count)
- Modify: `src/lib/due-follow-ups.ts` (`compareDueFollowUps`, `loadDueFollowUps`)
- Modify: `src/lib/reminders.ts`: `:747` (local `followUpDueSql` → shared), `:915-935` (light scan extras), `:1065-1076` (due set), `:1223-1245` (rows)
- Modify: `src/components/dashboard/due-follow-up-row.tsx:8-40` and `src/components/dashboard/dashboard-sections.tsx:457-514`
- Test: `scripts/smoke-due-follow-ups-parity.ts`, `scripts/smoke-dashboard-aggregates.ts`, `scripts/smoke-reminder-dedupe.ts`, `scripts/smoke-page-budgets.ts`, `scripts/smoke-behavior-golden.ts` (re-record)

**Interfaces:**
- Consumes: everything from Task 5.
- Produces:
  - Dashboard and `loadDueFollowUps` rows gain `keepInTouchDays: number | null` and `keepInTouchIsDefault: boolean`.
    - These are set only when the row is due because of its cadence (`nextFollowUpAt === null`).
    - Otherwise they are `null` and `false`.
  - `DueCandidate` gains `cadenceDueAt?: Date | string | null`.
  - `ContactListRow.keepInTouchDays: number | null` (the effective cadence).

- [ ] **Step 1: Write the failing tests.**

In `scripts/smoke-due-follow-ups-parity.ts`, add two contacts to its fixture:
- `innerLapsed`: `closenessTier: "inner"`, `lastInteractionAt` 31 days ago, no `nextFollowUpAt`.
- `outerQuiet`: `closenessTier: "outer"`, no touch for 400 days, no cadence.

Then assert:

```ts
check("inner contact with a lapsed default cadence is due on the dashboard",
  dashboard.dueFollowUps.some((c) => c.id === innerLapsed.id && c.keepInTouchDays === 30 && c.keepInTouchIsDefault));
check("and appears exactly once", dashboard.dueFollowUps.filter((c) => c.id === innerLapsed.id).length === 1);
check("outer contact with no cadence is not due", !dashboard.dueFollowUps.some((c) => c.id === outerQuiet.id));
check("loadDueFollowUps agrees", (await loadDueFollowUps(USER)).some((c) => c.id === innerLapsed.id));
const page = await listContactsPage(USER, { followUp: "due" });
check("followUp=due includes cadence-due", page.items.some((c) => c.id === innerLapsed.id));
check("followUp=due excludes the quiet outer contact", !page.items.some((c) => c.id === outerQuiet.id));
```

Also add an exact count assertion on `dashboard.stats.dueFollowUps`, computed from the file's fixture: the previously due contacts plus `innerLapsed`.

In `scripts/smoke-reminder-dedupe.ts`, add a generated pending reminder on a cadence-due contact (one with no `next_follow_up_at`). It must be dropped from `loadDashboardReminders` just as it is for a booked-due contact.

Restore every inserted row in `cleanup()`.

- [ ] **Step 2: Run them and confirm they fail.** Run `npx tsx scripts/smoke-due-follow-ups-parity.ts` and `npx tsx scripts/smoke-reminder-dedupe.ts`. Expected: FAIL on the new checks.

- [ ] **Step 3: Wire the shared predicate into the queries.**
  - `src/lib/contacts-page-query.ts:131-135`: change the condition to ``conditions.push(followUpDueSql(sql`now()`));``.
  - `src/lib/dashboard-aggregates.ts`: change the `due` filter to ``count(*) filter (where ${followUpDueSql(sql`now()`)})::int as due``. `overdue` stays about booked follow-ups; leave it alone.
  - `src/lib/reminders.ts:747`:
    - Delete the local `followUpDueSql(alias, now)`.
    - Where it was called with alias `due`, call the shared ``followUpDueSql(sql`${now.toISOString()}::timestamptz`, aliasColumns("due"))``.
    - Read `loadDashboardReminders` (`:786-803`). If the `due` join selects specific columns, add `cadence_days`, `closeness_tier`, `last_interaction_at`, `date_met` and `created_at`.
  - `src/lib/reminders.ts` light scan (`:915-935`): add to `extras`:

```ts
        // Computed, never the columns: the whole-network scan stays narrow (smoke-page-budgets).
        cadenceDueAt: cadenceDueAtSql().as("cadence_due_at"),
        effectiveCadence: effectiveCadenceSql().as("effective_cadence"),
        cadenceIsOwn: sql<boolean>`(${contacts.cadenceDays} > 0)`.as("cadence_is_own"),
```

  - The due set (`:1065-1069`):

```ts
  const dueAtOf = (c: { nextFollowUpAt: Date | string | null; cadenceDueAt: Date | string | null }) =>
    c.nextFollowUpAt ? new Date(c.nextFollowUpAt) : c.cadenceDueAt ? new Date(c.cadenceDueAt) : null;
  const dueFollowUpIds = new Set(
    lightContacts.filter((c) => { const at = dueAtOf(c); return at !== null && at <= now; }).map((c) => c.id)
  );
```

  - The rows (`:1223-1245`) add:

```ts
      keepInTouchDays: light.nextFollowUpAt ? null : (light.effectiveCadence ?? null),
      keepInTouchIsDefault: !light.nextFollowUpAt && light.effectiveCadence !== null && !light.cadenceIsOwn,
```

  - Update the dashboard row type wherever the element type of `dueFollowUps` is declared; let `tsc` find it.

- [ ] **Step 4: Update the shared due list** in `src/lib/due-follow-ups.ts`:
  - `DueCandidate` gains `cadenceDueAt?: Date | string | null`.
  - `compareDueFollowUps` computes `aTime` and `bTime` from `nextFollowUpAt ?? cadenceDueAt`.
  - `loadDueFollowUps`:
    - The where clause becomes ``and(eq(contacts.userId, userId), followUpDueSql(sql`now() + interval '1 hour'`))``.
    - Add the same three extras as the dashboard.
    - The JS filter uses the same `dueAtOf` rule.
    - Returned rows carry `keepInTouchDays` and `keepInTouchIsDefault` using the dashboard's formula.
  - The parity smoke holds the two lists equal, so copy one formula; don't reinvent it.

- [ ] **Step 5: Label the row.**
  - `due-follow-up-row.tsx` accepts `keepInTouchDays?: number | null` and `keepInTouchIsDefault?: boolean`. When `keepInTouchDays` is set, the due label reads:

```ts
`Keep in touch · ${cadenceName(keepInTouchDays).toLowerCase()}${keepInTouchIsDefault ? " (default)" : ""}`
```

  - Otherwise the row keeps `followUpDueLabel(nextFollowUpAt)`.
  - Pass the two props through in `dashboard-sections.tsx` (`:457-514`).

- [ ] **Step 6: Fix audit C5 on the contact page.**
  - In `contacts/[id]/page.tsx`, add `keepInTouchDays={contact.cadenceDays}`, `cadencePhrase={contact.cadencePhrase}` and `closenessTier={contact.closenessTier}` to `<StreamedFollowUp …/>`. Add the same three to `StreamedFollowUp`'s props type (`:497-515`); it already spreads `...rest` into `ContactFollowUpSection`.
  - In `contact-follow-up-section.tsx`:
    - Accept `cadencePhrase?: string | null` and `closenessTier?: "inner" | "mid" | "outer" | null`.
    - Next to the "Keep in touch" label, replace "Not set" with this status:

```ts
const own = cadence;                                // existing optimistic state
const effective = effectiveCadenceDays({ cadenceDays: own, closenessTier: closenessTier ?? null });
const cadenceStatus =
  own && cadencePhrase ? `“${cadencePhrase}”`
  : own ? cadenceName(own)
  : effective ? `${cadenceName(effective)} (${TIER_NAMES[closenessTier!]} default)`
  : "Not set";
```

    - Define `const TIER_NAMES = { inner: "Inner orbit", mid: "Mid orbit", outer: "Outer orbit" } as const;` locally for now. Task 11 replaces it with `ORBIT_TIER_LABELS`.
    - A cadence of 91, as derived from a note, must still highlight Quarterly. Change the preset button's `aria-pressed` test to `Math.abs((own ?? 0) - p.days) <= 1`.

- [ ] **Step 7: Contacts list tag.**
  - In `contacts-page-query.ts`, select `keepInTouchDays: effectiveCadenceSql()` next to `nameTier` and map it into the items (`:176-200`).
  - Add the field to `ContactListRow` and `ContactListItem`.
  - In `contacts-list.tsx` `ContactRow`, after the tier badge pair (`~:745`), add:

```tsx
{c.keepInTouchDays ? (
  <span className="hidden shrink-0 rounded-full border border-border/60 px-1.5 text-[11px] text-muted-foreground md:inline-flex">
    {cadenceName(c.keepInTouchDays)}
  </span>
) : null}
```

- [ ] **Step 8: Run the tests and confirm they pass.**
  - Run `npx tsx scripts/smoke-due-follow-ups-parity.ts`, `npx tsx scripts/smoke-reminder-dedupe.ts`, `npx tsx scripts/smoke-dashboard-aggregates.ts`, `npx tsx scripts/smoke-page-budgets.ts` and `npx tsc --noEmit`.
  - Expected: pass.
  - If `smoke-page-budgets` flags the new extras, read its assertion and keep them as computed extras. Never select raw `last_interaction_at` in the whole-network scan.

- [ ] **Step 9: Re-record the golden on purpose.**
  - Run `npx tsx scripts/smoke-behavior-golden.ts`. Expect diffs only in:
    - `dueFollowUps` (cadence-due rows and the two new fields);
    - `stats.dueFollowUps`;
    - `mcp due_followups`;
    - `v1 followups`;
    - reminders dropped by R2.
  - Read the diff. If anything else moved, stop and fix it.
  - Then run `npx tsx scripts/smoke-behavior-golden.ts --update`.

- [ ] **Step 10: Commit**

```bash
git add -A src scripts
git commit -m "feat(cadence): saved cadence shows (audit C5) and lapsed cadences come due

Dashboard Due follow-ups, the followUp=due filter, loadDueFollowUps and the R2 reminder
dedupe all read followUpDueSql. behavior-golden re-recorded: due follow-ups now include
cadence-due contacts (Inner monthly / Mid quarterly defaults).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Radar and outreach dormancy follow the effective cadence

**Files:**
- Modify: `src/lib/radar/score.ts:462-482` (dormancy gate)
- Modify: `src/lib/reminders.ts`: `:151-171` (projection), `:268-286` (`dormantHighValue`), `:388` (`followUpCandidateScore` threshold)
- Test: `scripts/smoke-radar-score.ts`, `scripts/smoke-keep-in-touch.ts`

**Interfaces:**
- Consumes: `effectiveCadenceDays` (Task 5). The Radar contact already carries `tier`, `cadenceDays` and `cadencePhrase`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests.**
  - In `scripts/smoke-radar-score.ts`, add a case using the file's existing contact builder:
    - An `outer` contact with `relationshipScore: 2`, `priorityLevel: 0`, `cadenceDays: 14`, `hasEvidence: false`, `lastInteractionAt` 20 days ago and no `nextFollowUpAt`. Assert `scoreContactKinds` yields a `reconnect` kind with a `dormant` reason.
    - The same contact with `cadenceDays: null`. Assert it yields none.
  - In `scripts/smoke-keep-in-touch.ts`, use whichever of `ensureOutreachSuggestions`/`refreshOutreachSuggestions` the file already drives:
    - An `inner`-tier contact with `relationshipScore: 2`, no own cadence and a last touch 35 days ago gets a `dormant_high_value` suggestion.
    - An `outer` contact with score 2, no cadence and 35 days quiet gets none.

- [ ] **Step 2: Run them and confirm they fail.** Run `npx tsx scripts/smoke-radar-score.ts` and `npx tsx scripts/smoke-keep-in-touch.ts`. Expected: FAIL on the new checks.

- [ ] **Step 3: Radar** (`score.ts:465`):

```ts
  const cadence = effectiveCadenceDays({ cadenceDays: contact.cadenceDays, closenessTier: contact.tier });
  const idle = daysSince(contact.lastInteractionAt, now);
  if (idle !== null && (cadence !== null || isHighValue(contact))) {
    const window = idleThresholdFor(cadence, DORMANT_DAYS);
```

The body is otherwise unchanged. Contacts with no effective cadence keep the high-value gate and the 30-day window.

- [ ] **Step 4: Outreach** (`reminders.ts`).
  - Add `closenessTier: true` to the projection (`:151-171`).
  - Replace the filter:

```ts
  const dormantHighValue = all.filter((c) => {
    if (!isDiscoveryEligible(c)) return false;
    const cadence = effectiveCadenceDays({ cadenceDays: c.cadenceDays, closenessTier: c.closenessTier });
    if (cadence === null && !(c.priorityLevel >= 2 || c.relationshipScore >= 4)) return false;
    return daysAgo(c.lastInteractionAt) >= idleThresholdFor(cadence, DORMANT_DAYS);
  });
```

  - Apply the same `idleThresholdFor(effectiveCadenceDays(…), DORMANT_DAYS)` substitution in `followUpCandidateScore` (`:388`).

- [ ] **Step 5: Run the tests and confirm they pass.**
  - Run `npx tsx scripts/smoke-radar-score.ts`, `npx tsx scripts/smoke-keep-in-touch.ts`, `npx tsx scripts/smoke-radar-run.ts` and `npx tsx scripts/smoke-behavior-golden.ts`.
  - If the golden changes, expect only `ai_suggestions`/`ensureOutreachSuggestions` entries for tier-default contacts. Read the diff, then run `--update`, and name it in the commit.

- [ ] **Step 6: Commit**

```bash
git add src/lib/radar/score.ts src/lib/reminders.ts scripts/smoke-radar-score.ts scripts/smoke-keep-in-touch.ts scripts/fixtures/behavior-golden.json
git commit -m "feat(cadence): Radar and outreach dormancy use the effective cadence for any contact

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Alumni and Target companies filters; Radar alumni reason

**Files:**
- Modify: `src/lib/school-name.ts`.
  - Move `SCHOOL_NOISE`, `schoolKeys` and `sharesSchool` here verbatim from `src/lib/events/relevance.ts:151-186`, and export them. `relevance.ts` imports them.
  - This deviates from the spec deliberately. `school-name.ts` had no normaliser to reuse, and moving the one that exists keeps a single normaliser.
- Create: `src/lib/audience-filters.ts`
- Modify: `src/lib/contacts-page.ts:93-112` (`alumni?: boolean; targets?: boolean`)
- Modify: `src/lib/contacts-page-query.ts` (conditions)
- Modify: `src/app/(clerk)/(app)/(main)/contacts/page.tsx:47-63,140` (parsing, `filtersActive`, `key`, availability)
- Modify: `src/components/contacts/contacts-filters.tsx:38-122,~215-283` (state, `apply()`, two toggles beside "Gone quiet")
- Modify:
  - `src/lib/radar/signals/internal.ts:233-327` (select `school`)
  - `src/lib/radar/run.ts:163-191,286-296`
  - `src/lib/radar/score.ts:52-97,150-175,509-519`
  - `src/lib/radar/types.ts:85-95`
- Create: `scripts/smoke-audience-filters.ts` (pglite)
- Modify: `scripts/run-smoke.ts`
- Test: `scripts/smoke-radar-score.ts`, plus the events relevance smoke (`grep -l sharesSchool scripts/smoke-*.ts`)

**Interfaces:**
- Consumes:
  - `listSchools(userId)` (`src/lib/events/target-companies.ts:95`) and `setSchools(userId, schools)`
  - `loadTargetKeys(userId): Promise<Map<string, number>>` (`src/lib/events/companies.ts:307`)
  - `companyMatchKeys(name)` (`src/lib/events/company-list-parse.ts:112`)
- Produces:
  - From `school-name.ts`: `schoolKeys(value: string): string[]` and `sharesSchool(a: string[], b: string[]): boolean`.
  - From `audience-filters.ts`:
    - `alumniSchoolValues(userId: string): Promise<string[]>`
    - `targetCompanyValues(userId: string): Promise<string[]>`
    - `audienceFilterAvailability(userId: string): Promise<{ hasSchools: boolean; hasTargets: boolean }>`
  - `ContactsPageFilters.alumni?: boolean` and `ContactsPageFilters.targets?: boolean`
  - `RadarContact.alumniSchool: string | null`, the reason code `"alumni"` in `CONTEXT_CODES`, and `RADAR_WEIGHTS.alumni = 6`

- [ ] **Step 1: Write the failing smoke** `scripts/smoke-audience-filters.ts`.
  - Start it from `import "./smoke/_env";` and the user-setup pattern used in Task 5.
  - Seed the user's schools as `["University of North Carolina at Chapel Hill"]` with `setSchools`.
  - Seed one target company with the helper `smoke-radar-run.ts` uses for `target_companies` (`grep -n target_companies scripts/smoke-radar-run.ts`, then copy it).
  - Seed four contacts:
    - A: school "UNC Chapel Hill", company = the target.
    - B: school "UNC Chapel Hill", another company.
    - C: no school, company = the target.
    - D: neither.
  - Assert:

```ts
const names = (p: Awaited<ReturnType<typeof listContactsPage>>) => p.items.map((c) => c.fullName).sort();
check("alumni", JSON.stringify(names(await listContactsPage(USER, { alumni: true }))) === JSON.stringify(["A", "B"]));
check("targets", JSON.stringify(names(await listContactsPage(USER, { targets: true }))) === JSON.stringify(["A", "C"]));
check("alumni AND targets", JSON.stringify(names(await listContactsPage(USER, { alumni: true, targets: true }))) === JSON.stringify(["A"]));
// Review Focus 5: no saved schools → zero rows, never everyone.
await setSchools(USER, []);
check("alumni with no schools returns nothing", (await listContactsPage(USER, { alumni: true })).items.length === 0);
check("availability reports it", (await audienceFilterAvailability(USER)).hasSchools === false);
```

  - Add a pure check that `sharesSchool(["University of North Carolina at Chapel Hill"], ["UNC Chapel Hill"])` is true. If the moved normaliser says false, switch the fixture to a pair the events relevance smoke already proves equal. Don't change the normaliser's behaviour in this task.
  - Restore the schools, targets and contacts in `cleanup()`.

- [ ] **Step 2: Run it and confirm it fails.** Run `npx tsx scripts/smoke-audience-filters.ts`. Expected: FAIL (missing module, unknown filter keys).

- [ ] **Step 3: Move the normaliser.**
  - Cut `SCHOOL_NOISE`, `schoolKeys` and `sharesSchool` verbatim from `src/lib/events/relevance.ts` into `src/lib/school-name.ts`, exported.
  - In `relevance.ts`, add `import { sharesSchool } from "@/lib/school-name";`.
  - Run the events relevance smoke. Expected: unchanged pass.

- [ ] **Step 4: Create** `src/lib/audience-filters.ts`. First confirm the Drizzle export name of the `target_companies` table with `grep -n '"target_companies"' src/db/schema.ts`, and use that name.

```ts
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, targetCompanies } from "@/db/schema";
import { companyMatchKeys } from "@/lib/events/company-list-parse";
import { loadTargetKeys } from "@/lib/events/companies";
import { listSchools } from "@/lib/events/target-companies";
import { sharesSchool } from "@/lib/school-name";

/**
 * The Alumni and Target companies filters, matched with the same rules the rest of Orbit uses
 * (`sharesSchool`, `companyMatchKeys`), not a SQL approximation of them. Each returns the exact
 * stored values that match, for an `IN (...)` on the contacts query.
 * ponytail: reads the user's distinct schools/companies per filtered page load; fine at
 * thousands of contacts, cache per request if it ever shows in a profile.
 */
async function distinctValues(userId: string, column: typeof contacts.school | typeof contacts.company): Promise<string[]> {
  const db = await getDb();
  const rows = await db.selectDistinct({ v: column }).from(contacts).where(and(eq(contacts.userId, userId), isNotNull(column)));
  return rows.map((r) => r.v).filter((v): v is string => Boolean(v && v.trim()));
}

export async function alumniSchoolValues(userId: string): Promise<string[]> {
  const [mine, theirs] = await Promise.all([listSchools(userId), distinctValues(userId, contacts.school)]);
  if (!mine.length) return [];
  return theirs.filter((s) => sharesSchool(mine, [s]));
}

export async function targetCompanyValues(userId: string): Promise<string[]> {
  const [keys, theirs] = await Promise.all([loadTargetKeys(userId), distinctValues(userId, contacts.company)]);
  if (!keys.size) return [];
  return theirs.filter((c) => companyMatchKeys(c).some((k) => keys.has(k)));
}

export async function audienceFilterAvailability(userId: string): Promise<{ hasSchools: boolean; hasTargets: boolean }> {
  const db = await getDb();
  const [schools, [targets]] = await Promise.all([
    listSchools(userId),
    db.select({ n: sql<number>`count(*)::int` }).from(targetCompanies).where(eq(targetCompanies.userId, userId)),
  ]);
  return { hasSchools: schools.length > 0, hasTargets: (targets?.n ?? 0) > 0 };
}
```

- [ ] **Step 5: Query conditions.** In `contacts-page-query.ts`, after the `followUp` block:

```ts
  if (filters?.alumni) {
    const schools = await alumniSchoolValues(userId);
    conditions.push(schools.length ? inArray(contacts.school, schools) : sql`false`);
  }
  if (filters?.targets) {
    const companies = await targetCompanyValues(userId);
    conditions.push(companies.length ? inArray(contacts.company, companies) : sql`false`);
  }
```

- [ ] **Step 6: Page and filter UI.**
  - `contacts/page.tsx`:
    - Parse `alumni: params.alumni === "1" || undefined` and `targets: params.targets === "1" || undefined`.
    - Add both to `filtersActive` and to the `key` join.
    - Load `audienceFilterAvailability(userId)` beside the list.
    - Pass `initialAlumni`, `initialTargets`, `hasSchools` and `hasTargets` to `ContactsFilters`.
  - `contacts-filters.tsx`:
    - Add `alumni` and `targets` (`"1" | ""`) to `FilterState` and to state.
    - `apply()` rebuilds the URL from scratch, so carry both through every call: `if (next.alumni === "1") params.set("alumni", "1"); if (next.targets === "1") params.set("targets", "1");`.
    - Render two toggles beside the "Gone quiet" dropdown, matching its size and variant idiom exactly. `title` is invisible on touch, which is why the link to Settings is rendered as well.

```tsx
<Button type="button" size="sm" variant={alumni === "1" ? "default" : "outline"} aria-pressed={alumni === "1"}
  disabled={!hasSchools} title={hasSchools ? "People from your schools" : "Add your schools in Settings → Goals and targets"}
  onClick={() => { const next = alumni === "1" ? "" : "1"; setAlumni(next); apply({ alumni: next }); }}>
  Alumni
</Button>
<Button type="button" size="sm" variant={targets === "1" ? "default" : "outline"} aria-pressed={targets === "1"}
  disabled={!hasTargets} title={hasTargets ? "People at your target companies" : "Add target companies in Settings → Goals and targets"}
  onClick={() => { const next = targets === "1" ? "" : "1"; setTargets(next); apply({ targets: next }); }}>
  Target companies
</Button>
{(!hasSchools || !hasTargets) && (
  <Link href="/settings#settings-targets" className="text-xs text-muted-foreground underline-offset-2 hover:underline">
    Add schools and targets
  </Link>
)}
```

- [ ] **Step 7: Radar alumni reason.**
  - `internal.ts`: add `school` to the candidate select and to `RadarCandidateRow`.
  - `run.ts`:
    - Add `listSchools(userId)` to the `Promise.all` at `:286`, so the schools are read once per run.
    - Pass `schools` into `toRadarContact`, which sets `alumniSchool: row.school && schools.length && sharesSchool(schools, [row.school]) ? row.school : null`.
  - `score.ts`: add `alumniSchool: string | null` to `RadarContact` and `alumni: 6` to the context weights. After the `target_company` reason, add:

```ts
    if (contact.alumniSchool) {
      reasons.push({ code: "alumni", label: `Went to ${contact.alumniSchool} too`, points: W.alumni });
    }
```

  - `types.ts`: add `"alumni"` to `CONTEXT_CODES`.
  - Update every `RadarContact` literal that `tsc` reports (smoke builders included) with `alumniSchool: null`.
  - In `smoke-radar-score.ts`, add a check: a contact with `alumniSchool: "UNC Chapel Hill"` gets an `alumni` reason worth 6 with that exact label.

- [ ] **Step 8: Run the tests and confirm they pass.** Run `npx tsx scripts/smoke-audience-filters.ts`, `npx tsx scripts/smoke-radar-score.ts`, `npx tsx scripts/smoke-radar-run.ts`, the events relevance smoke and `npx tsc --noEmit`. Expected: pass.

- [ ] **Step 9: Register and commit**

```bash
git add -A src scripts
git commit -m "feat(contacts): Alumni and Target companies filters; Radar alumni reason

Moves schoolKeys/sharesSchool into school-name.ts so events and contacts share one
school normaliser.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Profile fields: schema 153, action, Settings UI

**Files:**
- Modify: `src/db/index.ts`:
  - the DDL `user_settings` block (after `career_profile jsonb,`, ~line 69);
  - `migratePglite` (`ensureColumn` after `:3391`);
  - `alters` (after `:4166`);
  - the changelog above `SCHEMA_VERSION` (`:2584-2597`);
  - `SCHEMA_VERSION = 153`.
- Modify: `src/db/schema.ts:257-268` (three Drizzle columns)
- Modify: `scripts/schema-ddl.lock.json` (via `--update`)
- Modify: `src/lib/sender-profile.ts` (normaliser and facts line)
- Modify: `src/actions/settings.ts:~169,190-205` (initial values; `saveSearchProfile`)
- Modify: `src/components/settings/profile-settings.tsx:139-180` and `src/app/(clerk)/(app)/settings/page.tsx:~180` (props)
- Test: `scripts/smoke-sender-profile.ts` (pure additions), `scripts/smoke-schema-ddl.ts`, `scripts/smoke-settings-export.ts`, `scripts/smoke-data-export.ts`, `scripts/smoke-preserved-settings.ts`, `scripts/smoke-purge.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - Drizzle `userSettings.targetRole: text`, `userSettings.graduationYear: integer`, and `userSettings.searchStatus: text` typed as `SearchStatus | null`.
  - From `sender-profile.ts`:
    - `type SearchStatus = "not_looking" | "open" | "active"`
    - `SEARCH_STATUS_OPTIONS`, with labels "Not looking", "Open to opportunities" and "Actively looking"
    - `TARGET_ROLE_MAX_LENGTH = 120`
    - `type SearchProfile = { targetRole: string | null; graduationYear: number | null; searchStatus: SearchStatus | null }`
    - `normalizeSearchProfile(input: unknown): SearchProfile`
    - `senderFactsLine(p: SearchProfile, now?: Date): string | null`
  - Server action `saveSearchProfile(input: SearchProfile): Promise<SearchProfile>`.

- [ ] **Step 1: Write the failing tests.** Append to `scripts/smoke-sender-profile.ts`, using its existing assertion helper (rename `eq` if the file calls it something else):

```ts
console.log("search profile");
const NOW = new Date("2026-10-11T12:00:00Z");
eq("normalises", normalizeSearchProfile({ targetRole: "  new-grad software engineering  ", graduationYear: 2027, searchStatus: "active" }),
  { targetRole: "new-grad software engineering", graduationYear: 2027, searchStatus: "active" });
eq("rejects junk", normalizeSearchProfile({ targetRole: "", graduationYear: 1800, searchStatus: "hunting" }),
  { targetRole: null, graduationYear: null, searchStatus: null });
eq("caps role", normalizeSearchProfile({ targetRole: "x".repeat(200) }).targetRole?.length, 120);
eq("year as string from a form", normalizeSearchProfile({ graduationYear: "2027" }).graduationYear, 2027);
eq("facts line", senderFactsLine({ targetRole: "new-grad software engineering", graduationYear: 2027, searchStatus: "active" }, NOW),
  "About the sender: Graduating in 2027; looking for new-grad software engineering roles; actively looking");
eq("past year reads graduated", senderFactsLine({ targetRole: null, graduationYear: 2020, searchStatus: null }, NOW),
  "About the sender: Graduated in 2020");
eq("not looking", senderFactsLine({ targetRole: "product design", graduationYear: null, searchStatus: "not_looking" }, NOW),
  "About the sender: interested in product design roles; not looking right now");
eq("empty is null", senderFactsLine({ targetRole: null, graduationYear: null, searchStatus: null }, NOW), null);
```

- [ ] **Step 2: Run it and confirm it fails.** Run `npx tsx scripts/smoke-sender-profile.ts`. Expected: FAIL on the missing exports.

- [ ] **Step 3: Implement the pure part** in `src/lib/sender-profile.ts`:

```ts
export type SearchStatus = "not_looking" | "open" | "active";
export const SEARCH_STATUS_OPTIONS: readonly { value: SearchStatus; label: string }[] = [
  { value: "not_looking", label: "Not looking" },
  { value: "open", label: "Open to opportunities" },
  { value: "active", label: "Actively looking" },
];
export const TARGET_ROLE_MAX_LENGTH = 120;
export type SearchProfile = { targetRole: string | null; graduationYear: number | null; searchStatus: SearchStatus | null };

export function normalizeSearchProfile(input: unknown): SearchProfile {
  const v = (input ?? {}) as Record<string, unknown>;
  const role = typeof v.targetRole === "string" ? v.targetRole.trim().slice(0, TARGET_ROLE_MAX_LENGTH) : "";
  const year = typeof v.graduationYear === "string" ? Number(v.graduationYear) : v.graduationYear;
  const status = SEARCH_STATUS_OPTIONS.some((o) => o.value === v.searchStatus) ? (v.searchStatus as SearchStatus) : null;
  return {
    targetRole: role || null,
    graduationYear: typeof year === "number" && Number.isInteger(year) && year >= 1950 && year <= 2100 ? year : null,
    searchStatus: status,
  };
}

const STATUS_PHRASE: Record<SearchStatus, string> = {
  active: "actively looking",
  open: "open to opportunities",
  not_looking: "not looking right now",
};

/** One line for the draft prompt, beside the bio. Null when nothing is set. */
export function senderFactsLine(p: SearchProfile, now: Date = new Date()): string | null {
  const parts: string[] = [];
  if (p.graduationYear) parts.push(`${p.graduationYear >= now.getUTCFullYear() ? "Graduating" : "Graduated"} in ${p.graduationYear}`);
  if (p.targetRole) parts.push(`${p.searchStatus === "not_looking" ? "interested in" : "looking for"} ${p.targetRole} roles`);
  if (p.searchStatus) parts.push(STATUS_PHRASE[p.searchStatus]);
  return parts.length ? `About the sender: ${parts.join("; ")}` : null;
}
```

- [ ] **Step 4: Schema.** Rescan as described in Global Constraints. If anything claims 153, take the next free number and use it everywhere below.

`schema.ts`, after `careerProfile`:

```ts
  /** What the user is looking for (Settings → Profile). Content: exported, cleared by the preferences purge. */
  targetRole: text("target_role"),
  graduationYear: integer("graduation_year"),
  searchStatus: text("search_status").$type<"not_looking" | "open" | "active">(),
```

`index.ts`, in the DDL template after `career_profile jsonb,`:

```sql
  target_role text,
  graduation_year integer,
  search_status text,
```

`migratePglite`, after the `career_profile` `ensureColumn`:

```ts
  await ensureColumn(client, "user_settings", "target_role", "text");
  await ensureColumn(client, "user_settings", "graduation_year", "integer");
  await ensureColumn(client, "user_settings", "search_status", "text");
```

`alters`, after the `career_profile` alter:

```ts
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS target_role text`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS graduation_year integer`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS search_status text`,
```

The changelog, after the 151 entry:

```ts
//
// 153 = Sprint C profile fields: user_settings.target_role, graduation_year, search_status.
// Rescanned every remote ref (151 highest) and every worktree's working file on Oct 11 2026:
// calendar-events-p0 holds 152 unpushed, so this takes 153.
```

Set `export const SCHEMA_VERSION = 153;`, then run `npx tsx scripts/smoke-schema-ddl.ts --update` followed by `npx tsx scripts/smoke-schema-ddl.ts`.

- [ ] **Step 5: Action.** In `src/actions/settings.ts`, beside `saveSenderBio`:

```ts
export async function saveSearchProfile(input: SearchProfile) {
  const userId = await requireUserId();
  const db = await getDb();
  const p = normalizeSearchProfile(input);
  await db.insert(userSettings).values({ userId, ...p })
    .onConflictDoUpdate({ target: userSettings.userId, set: { ...p, updatedAt: new Date() } });
  revalidatePath("/settings");
  return p;
}
```

Add `targetRole`, `graduationYear` and `searchStatus` to the settings payload (`~:169`) in the same way `senderBio` is added.

- [ ] **Step 6: Settings UI.**
  - In `settings/page.tsx`, pass `initialSearchProfile={{ targetRole: initialSettings.targetRole ?? null, graduationYear: initialSettings.graduationYear ?? null, searchStatus: initialSettings.searchStatus ?? null }}`.
  - In `profile-settings.tsx`, add the row below after the "About you" `SettingsRow` (`:139-177`).
    - Copy the bio row's pending, `useTransition` and error handling exactly, including the friendly-error toast on failure.
    - If the file already uses the ui `Select` primitive, use it; otherwise keep the native `<select>`.

```tsx
<SettingsRow
  title="What you’re looking for"
  description="Orbit uses this to rank who to reach out to and to introduce you in drafts"
>
  <div className="grid gap-2 md:grid-cols-[1fr_8rem_12rem]">
    <Input aria-label="Target role" placeholder="New-grad software engineering" maxLength={TARGET_ROLE_MAX_LENGTH}
      value={search.targetRole ?? ""} onChange={(e) => setSearch({ ...search, targetRole: e.target.value })} />
    <Input aria-label="Graduation year" type="number" inputMode="numeric" min={1950} max={2100} placeholder="2027"
      value={search.graduationYear ?? ""} onChange={(e) => setSearch({ ...search, graduationYear: e.target.value ? Number(e.target.value) : null })} />
    <select aria-label="Search status" className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
      value={search.searchStatus ?? ""} onChange={(e) => setSearch({ ...search, searchStatus: (e.target.value || null) as SearchStatus | null })}>
      <option value="">Search status</option>
      {SEARCH_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </div>
  <Button size="sm" className="mt-2" disabled={searchPending}
    onClick={() => startSearch(async () => { const saved = await saveSearchProfile(search); setSearch(saved); toast.success("Saved"); })}>
    Save
  </Button>
</SettingsRow>
```

- [ ] **Step 7: Run the tests and confirm they pass.**
  - Run `npx tsx scripts/smoke-sender-profile.ts`, `npx tsx scripts/smoke-schema-ddl.ts`, `npx tsx scripts/smoke-settings-export.ts`, `npx tsx scripts/smoke-data-export.ts`, `npx tsx scripts/smoke-preserved-settings.ts`, `npx tsx scripts/smoke-purge.ts` and `npx tsc --noEmit`.
  - Expected: pass. The three columns are content, so they stay out of `PRESERVED_SETTINGS_COLUMNS`, and none has a credential-shaped name.

- [ ] **Step 8: Commit**

```bash
git add -A src scripts
git commit -m "feat(settings): target role, graduation year and search status (schema 153)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Profile fields feed Radar, Goals and drafts

**Files:**
- Modify: `src/lib/career-profile-server.ts:11-31` (`loadYouCurrent`, `loadUserFocus`) and the `YouCurrent` type in `src/lib/career-profile.ts`
- Modify: `src/lib/focus-fit.ts:19-32,62-82` (`UserFocus.searchActive`, the recruiter rule)
- Modify: `src/lib/radar/run.ts:163-191` and `src/lib/radar/score.ts:509-519` (active-search boost)
- Modify: `src/lib/sender-profile-server.ts:13-24` (`loadSearchProfile`) and `src/lib/follow-up-drafts.ts:190-191`
- Test:
  - the smoke that pins `focusFitComponent` (`grep -l focusFitComponent scripts/smoke-*.ts`)
  - `scripts/smoke-radar-score.ts`
  - `scripts/smoke-linkedin-you-db.ts`
  - `scripts/smoke-sender-profile.ts`

**Interfaces:**
- Consumes: `SearchProfile`, `normalizeSearchProfile` and `senderFactsLine` (Task 9); `RadarContact.alumniSchool` and `W.alumni` (Task 8).
- Produces:
  - `UserFocus.searchActive?: boolean`
  - `RadarContact.searchActive?: boolean`
  - `loadSearchProfile(userId: string): Promise<SearchProfile>`, which returns all-null on error, like `loadSenderBio`

- [ ] **Step 1: Write the failing tests.**

In the focus-fit smoke:

```ts
eq("target role alone makes a role focus", focusFitComponent({ title: "Software Engineer" }, { skills: [], roleKeywords: ["software engineering"] }) > 0, true);
eq("recruiters count while actively searching, even without alerts",
  focusFitComponent({ title: "Technical Recruiter" }, { skills: [], roleKeywords: [], searchActive: true }), 0.15);
eq("recruiters don't count when not searching", focusFitComponent({ title: "Technical Recruiter" }, { skills: ["go"], roleKeywords: [] }), 0);
```

In `smoke-radar-score.ts`:
- A target-company contact with `searchActive: true` scores `Math.round(W.targetCompany[2] * 1.5)` on its `target_company` reason.
- The same contact with `searchActive: false` scores `W.targetCompany[2]`.
- Add the same pair for `alumni`.

In `smoke-linkedin-you-db.ts` (pglite; it already drives `user_settings`):
- Set `career_profile` null, `target_role = "product design"` and `search_status = "active"`.
- Assert that `loadUserFocus` returns `{ skills: [], roleKeywords: ["product design"], searchActive: true }`.
- Restore the row afterwards.

- [ ] **Step 2: Run them and confirm they fail.** Expected: FAIL on the new checks.

- [ ] **Step 3: Focus.**
  - `loadYouCurrent` also selects `targetRole: userSettings.targetRole` and `searchStatus: userSettings.searchStatus`.
  - Extend `YouCurrent` with `targetRole?: string | null; searchStatus?: string | null`.
  - Rewrite `loadUserFocus`:

```ts
export async function loadUserFocus(userId: string): Promise<UserFocus | null> {
  const { career, targetRole, searchStatus } = await loadYouCurrent(userId);
  const skills = (career?.skills ?? []).filter((s) => typeof s === "string" && s.trim());
  const roleKeywords = (career?.roleKeywords ?? []).filter((s) => typeof s === "string" && s.trim());
  const role = targetRole?.trim();
  if (role && !roleKeywords.some((k) => k.toLowerCase() === role.toLowerCase())) roleKeywords.unshift(role);
  const searchActive = searchStatus === "active";
  if (!skills.length && !roleKeywords.length && !searchActive) return null;
  return { skills, roleKeywords, role: career?.role ?? null, searchActive };
}
```

`focus-fit.ts`:
- Add `searchActive?: boolean` to `UserFocus`.
- Change the guard and the recruiter rule:

```ts
  if (!focus || (!focus.skills.length && !focus.roleKeywords.length && !focus.searchActive)) return 0;
  // …
  if (focus.roleKeywords.length && focus.roleKeywords.some((k) => termHits(k, haystack))) score += 0.25;
  // The people who actually place people, while you are searching: job alerts, or "Actively looking".
  if ((focus.roleKeywords.length || focus.searchActive) && RECRUITING_TITLE.test(contact.title ?? "")) score += 0.15;
```

- This keeps today's behaviour for users with job alerts: role keywords still enable the recruiter bonus.
- Keep the existing focus-fit checks green.

- [ ] **Step 4: Radar boost.**
  - In `run.ts` `toRadarContact`, set `searchActive: focus?.searchActive ?? false`.
  - In `score.ts`, add `searchActive?: boolean` to `RadarContact` and `const boost = contact.searchActive ? 1.5 : 1;`. Score `target_company` as `Math.round(W.targetCompany[contact.targetPriority] * boost)` and alumni as `Math.round(W.alumni * boost)`.
  - Goals ranking also reads `loadUserFocus`, the one reader the recommenders share. Confirm with `grep -rn loadUserFocus src`. If a goals caller builds its own focus, route it through `loadUserFocus`.

- [ ] **Step 5: Draft sender line.**
  - In `sender-profile-server.ts`, add `loadSearchProfile(userId)`. It selects the three columns and returns them through `normalizeSearchProfile`, or all-null on error.
  - In `follow-up-drafts.ts:190`:

```ts
  const [bio, search] = await Promise.all([loadSenderBio(input.userId), loadSearchProfile(input.userId)]);
  const senderBlock = [senderProfileBlock(bio), senderFactsLine(search)].filter(Boolean).join("\n") || null;
```

  - Keep the variable name `senderBlock`, so `composeDraftContext` and the system rule at `:252` pick it up unchanged.
  - If `composeDraftContext` is pure and exported, add a check to `smoke-sender-profile.ts`: with only the search profile set, the composed context contains the facts line.

- [ ] **Step 6: Run the tests and confirm they pass.** Run the focus-fit smoke, `smoke-radar-score`, `smoke-radar-run`, `smoke-linkedin-you-db`, `smoke-sender-profile`, any follow-up-drafts smoke (`grep -l follow-up-drafts scripts/smoke-*.ts`), and `npx tsc --noEmit`.

- [ ] **Step 7: Commit**

```bash
git add -A src scripts
git commit -m "feat(profile): target role and search status steer Radar/Goals; drafts introduce the sender

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: One score vocabulary

**Files:**
- Create: `src/lib/score-labels.ts`
- Modify: `src/lib/graph-layout.ts:29-35` (re-export `RING_LABELS`)
- Modify: `src/components/graph/network-graph.tsx:1010-1026`
- Modify: `src/components/dashboard/network-depth-chart.tsx:15-47`
- Modify:
  - `src/components/dashboard/closeness-tier-badge.tsx:3-7`
  - `src/components/knowledge/dossier-pane.tsx:17`
  - `src/components/contacts/contacts-list.tsx:161-165,1029-1071`
  - `src/lib/network-stats.ts:162`
  - `src/components/interest/app-demo/demo-ui.tsx:147-149`
- Modify: `src/components/contacts/contacts-filters.tsx:30-36,415-447` (the filter label becomes "Strength")
- Modify: `src/components/capture/review/closeness-control.tsx:17` (default `label`)
- Modify: `src/components/contacts/contact-stat-pills.tsx:52-71` and `src/components/contacts/health-sparkline.tsx:58-96` (wording only where it names a score)
- Modify: `src/components/contacts/contact-follow-up-section.tsx` (replace Task 6's local `TIER_NAMES` with `ORBIT_TIER_LABELS`)
- Create: `scripts/smoke-score-vocabulary.ts` (pure)
- Modify: `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `STRENGTH_LABEL = "Strength"`, `CLOSENESS_LABEL = "Closeness"`, `ORBIT_LABEL = "Orbit"`, `HEALTH_LABEL = "Health"`
  - `ORBIT_TIER_LABELS = { inner: "Inner orbit", mid: "Mid orbit", outer: "Outer orbit" } as const`
  - `ORBIT_TIER_SHORT = { inner: "Inner", mid: "Mid", outer: "Outer" } as const`
  - `RING_LABELS: Record<1 | 2 | 3 | 4 | 5, string>`

- [ ] **Step 1: Write the failing smoke** `scripts/smoke-score-vocabulary.ts`:

```ts
/**
 * One name per score: Strength (1–5 rating), Closeness (computed %), Orbit (Inner/Mid/Outer
 * tier), Health. Graph rings have their own names, so "Inner orbit" means the tier only.
 * Pure: reads the label module and the files that used to carry their own copies.
 * Run: npx tsx scripts/smoke-score-vocabulary.ts
 */
import { readFileSync } from "node:fs";
import { ORBIT_TIER_LABELS, RING_LABELS } from "../src/lib/score-labels";
import { RING_LABELS as GRAPH_RINGS } from "../src/lib/graph-layout";

let failures = 0;
const fail = (m: string) => { failures++; console.error(`  FAIL ${m}`); };
const read = (f: string) => readFileSync(f, "utf8");

if (JSON.stringify(RING_LABELS) !== JSON.stringify({ 1: "Deep space", 2: "Far", 3: "Middle", 4: "Close", 5: "Core" })) fail("ring labels changed");
if (GRAPH_RINGS !== RING_LABELS) fail("graph-layout must re-export the shared ring labels");
if (Object.values(RING_LABELS).some((l) => /orbit/i.test(l))) fail("a ring label says orbit");
if (ORBIT_TIER_LABELS.inner !== "Inner orbit") fail("tier label changed");

const chart = read("src/components/dashboard/network-depth-chart.tsx");
if (/label:\s*"(Close|Warm|Cool)"/.test(chart)) fail("network-depth-chart still uses Close/Warm/Cool tier labels");
if (/Relationship strength/.test(chart)) fail("network-depth-chart heading still says Relationship strength");

const filters = read("src/components/contacts/contacts-filters.tsx");
if (/>\s*Closeness\s*</.test(filters) || /"Closeness"/.test(filters)) fail("the 1–5 filter is still labelled Closeness");

const graph = read("src/components/graph/network-graph.tsx");
if (/(Inner|Mid|Outer|Core) orbit/.test(graph)) fail("network-graph ring filter still says orbit");

for (const f of [
  "src/components/dashboard/closeness-tier-badge.tsx",
  "src/components/knowledge/dossier-pane.tsx",
  "src/components/contacts/contacts-list.tsx",
  "src/components/contacts/contact-follow-up-section.tsx",
  "src/lib/graph-layout.ts",
  "src/components/graph/network-graph.tsx",
]) {
  if (/"(Inner|Mid|Outer) orbit"/.test(read(f))) fail(`${f} carries its own tier label string`);
}
if (failures) { console.error(`\n${failures} vocabulary check(s) failed`); process.exit(1); }
console.log("all vocabulary checks passed");
process.exit(0);
```

- [ ] **Step 2: Run it and confirm it fails.** Run `npx tsx scripts/smoke-score-vocabulary.ts`. Expected: FAIL (missing module).

- [ ] **Step 3: Create** `src/lib/score-labels.ts`:

```ts
/**
 * Every relationship score's name, in one place. Strength is the 1–5 rating you give,
 * Closeness the computed %, Orbit the Inner/Mid/Outer tier, Health how the conversation is
 * going. Graph rings (by Strength) have their own names so "Inner orbit" only ever means
 * the tier. Copy only: no scoring, storage or URL params depend on these strings.
 */
export const STRENGTH_LABEL = "Strength";
export const CLOSENESS_LABEL = "Closeness";
export const ORBIT_LABEL = "Orbit";
export const HEALTH_LABEL = "Health";

export const ORBIT_TIER_LABELS = { inner: "Inner orbit", mid: "Mid orbit", outer: "Outer orbit" } as const;
export const ORBIT_TIER_SHORT = { inner: "Inner", mid: "Mid", outer: "Outer" } as const;

export const RING_LABELS: Record<1 | 2 | 3 | 4 | 5, string> = {
  5: "Core",
  4: "Close",
  3: "Middle",
  2: "Far",
  1: "Deep space",
};
```

- [ ] **Step 4: Relabel every consumer.**
  - **`graph-layout.ts`:**
    - Replace the local map with `export { RING_LABELS } from "@/lib/score-labels";`. Keep the doc comment about score 5 being closest to the sun.
    - The key type narrows from `number` to `1|2|3|4|5`. Where `tsc` complains, index with `RING_LABELS[score as 1 | 2 | 3 | 4 | 5]` after the existing clamp.
  - **`network-graph.tsx:1010-1026`:**
    - The heading becomes `Min strength`.
    - The items become `{([1, 2, 3, 4, 5] as const).map((n) => <SelectItem key={n} value={String(n)}>{n === 5 ? "5" : `${n}+`} {RING_LABELS[n]}</SelectItem>)}`.
  - **`network-depth-chart.tsx`:**
    - The `TIER_META` labels become `ORBIT_TIER_SHORT.inner`, `.mid` and `.outer`.
    - The heading "Relationship strength" becomes `ORBIT_LABEL`.
    - The comment at `:47` becomes "the real Inner/Mid/Outer shares".
  - **Local tier maps:** in `closeness-tier-badge.tsx`, `dossier-pane.tsx:17` and `contacts-list.tsx` `TIER_TOOLTIP`, import `ORBIT_TIER_LABELS` and delete the local maps. Do the same in `contact-follow-up-section.tsx`, replacing `TIER_NAMES`.
  - **`network-stats.ts:162` and `demo-ui.tsx:147-149`:** use `ORBIT_TIER_LABELS.*`.
  - **`contacts-filters.tsx`:**
    - The dropdown's visible label, and any `aria-label` that reads "Closeness", becomes `STRENGTH_LABEL`.
    - Rename `CLOSENESS_OPTIONS` to `STRENGTH_OPTIONS`.
    - The `minScore` param stays.
  - **`closeness-control.tsx:17`:** `label = STRENGTH_LABEL`.
  - **`contacts-list.tsx` `ClosenessChip` (`~:1041`):**
    - The fallback chip `Score ${relationshipScore}` becomes `` `${STRENGTH_LABEL} ${relationshipScore}` ``.
    - In the tooltip text, "relationship strength" becomes "your Strength rating".
  - **`contact-stat-pills.tsx`:** "your rating" becomes "your Strength rating". The rest already says Closeness and Health.
  - **`health-sparkline.tsx`:** "Relationship health" in the aria label becomes `${HEALTH_LABEL}`, so it reads `Health ${current} of 100…`.
  - **Unchanged:** `onboarding/highlights/previews.tsx:124` keeps its static "Inner orbit" chip, which correctly names the tier.

- [ ] **Step 5: Run the tests and confirm they pass.**
  - Run `npx tsx scripts/smoke-score-vocabulary.ts`, plus any smoke that pins ring or tier strings (`grep -l "RING_LABELS\|Inner orbit\|Close\b" scripts/smoke-*.ts`).
  - Run `npx tsc --noEmit`, and `npx eslint` on the touched files.
  - If `smoke-behavior-golden` or `smoke-dashboard*` pins these strings, re-record only those strings and name them in the commit.

- [ ] **Step 6: Register and commit**

```bash
git add -A src scripts
git commit -m "feat(copy): one score vocabulary: Strength, Closeness, Orbit, Health; graph rings renamed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Full verification and localhost acceptance (controller)

**Files:** none, beyond fixes the runs demand.

- [ ] **Step 1: Run the full gates.**
  - `npm test`
  - `npx tsx scripts/run-smoke.ts --check`
  - `npx tsc --noEmit`
  - `npx eslint src scripts`
  - `npx tsx scripts/smoke-provider-exhaustive.ts`, re-keying any allowlist line drift

  Expected: all pass, with 0 eslint errors. Under load, `admin-render` and `instrumentation` time out as a known flake; re-run them alone before calling it a failure.

- [ ] **Step 2: Acceptance walk.**
  - Use headless Playwright with system Chrome, against a fresh dev server on a free port. Never use 3000.
  - Follow the pattern in the session scratchpad's `accept/drive.mjs`, with a temporary `.env.local` and demo data off.
  - Set the browser clock with `page.clock.setFixedTime` and the zone with `timezoneId: "America/New_York"`.

  Checks:
  1. **Presets:** on the contact page, "Next day" on a Friday at 15:30 books Monday 09:00 local. Confirm it on the contact, on the dashboard row and in the bell. The bell's snooze opens a menu of the five presets.
  2. **Radar:** use the "Preview unreleased" cookie, because Radar is coming-soon locally. A "2 days" schedule books two days out.
  3. **Keep in touch:** "Monthly" persists across a reload (audit C5).
  4. **Cadence due:** an Inner orbit contact with no touch in 31 days and no cadence of its own appears once in Due follow-ups, labelled "Keep in touch · monthly (default)".
  5. **Filters:**
     - Alumni + Target companies return exactly the matching contacts.
     - With no schools saved, the Alumni toggle is disabled and the Settings link shows.
  6. **Profile:** saving target role, graduation year and "Actively looking" changes the draft's sender line. Read it from the draft request, or from the server log if no AI key is set.
  7. **Intents:** the draft sheet and the contact page show the four intent chips, and one tap starts a draft with the instruction in the field.
  8. **Vocabulary:**
     - The dashboard reads Orbit: Inner / Mid / Outer.
     - The graph filter reads Core / Close / Middle / Far / Deep space.
     - The contacts filter reads Strength.

- [ ] **Step 3: Report.** Give each check pass/fail with a screenshot, and name anything that was not browser-checked. Don't push.
