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
 *
 * ## Expanding in the event's own zone
 *
 * A recurring meeting is a WALL-CLOCK commitment ("Tuesdays at 9am"), not a fixed UTC instant
 * repeated every N seconds. So each occurrence is built by taking the master's local
 * wall-clock time-of-day, stepping the CALENDAR date (a pure, DST-free operation — adding days
 * to a `Date.UTC` anchor never touches a real zone), and re-resolving that wall clock to an
 * instant with `fromWallClockInput`, the same function `calendar-import.ts` already uses for
 * `TZID` handling. That is what keeps a 09:00 meeting at 09:00 local across a DST change,
 * even though its UTC hour moves.
 */
import type { ParsedCalendarEvent } from "@/lib/calendar-import";
import { fromWallClockInput, toWallClockInput } from "@/lib/events/wall-clock";

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

/** A pure calendar date — no time-of-day, no zone. Used only for stepping between candidates. */
type Civil = { y: number; mo: number; d: number };

const FREQS = new Set<RecurrenceRule["freq"]>(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
const WEEKDAY_INDEX: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

function civilKey(c: Civil): string {
  return `${pad4(c.y)}-${pad2(c.mo)}-${pad2(c.d)}`;
}

/** `UNTIL`'s value: a bare `YYYYMMDD` date, or the `YYYYMMDDTHHMMSSZ` form ICS actually writes. */
function parseUntil(raw: string): Date | null {
  const value = raw.trim();
  const utc = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (utc) {
    return new Date(
      Date.UTC(
        Number(utc[1]),
        Number(utc[2]) - 1,
        Number(utc[3]),
        Number(utc[4]),
        Number(utc[5]),
        Number(utc[6])
      )
    );
  }
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dateOnly) {
    // A bare DATE for UNTIL is inclusive of the whole day.
    return new Date(
      Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 23, 59, 59)
    );
  }
  return null;
}

export function parseRRule(line: string): RecurrenceRule | null {
  const colon = line.indexOf(":");
  const body = colon >= 0 ? line.slice(colon + 1) : line;
  const fields = new Map<string, string>();
  for (const part of body.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toUpperCase();
    const value = part.slice(eq + 1).trim();
    if (key) fields.set(key, value);
  }

  const freq = fields.get("FREQ");
  if (!freq || !FREQS.has(freq as RecurrenceRule["freq"])) return null;

  const intervalRaw = fields.get("INTERVAL");
  const parsedInterval = intervalRaw ? Number(intervalRaw) : 1;
  const interval = Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval : 1;

  const countRaw = fields.get("COUNT");
  const parsedCount = countRaw ? Number(countRaw) : null;
  const count = parsedCount !== null && Number.isFinite(parsedCount) ? parsedCount : null;

  const untilRaw = fields.get("UNTIL");
  const until = untilRaw ? parseUntil(untilRaw) : null;

  const byDay = (fields.get("BYDAY") ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const byMonthDay = (fields.get("BYMONTHDAY") ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n !== 0);
  const bySetPos = (fields.get("BYSETPOS") ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n !== 0);

  return { freq: freq as RecurrenceRule["freq"], interval, count, until, byDay, byMonthDay, bySetPos };
}

/** The occurrence id shape. Non-recurring events never pass through here. */
export function occurrenceUid(uid: string, start: Date): string {
  return `${uid}_${start.toISOString()}`;
}

/**
 * Whether `uid` carries the `_<instant>` suffix `occurrenceUid` produces — i.e. whether it
 * names an occurrence that was DERIVED by expansion, as opposed to a plain event's own uid or
 * a recurring series' master occurrence (which keeps its bare uid; see `expandEvent`'s own
 * comment on that ruling). Callers use this to single out the synthetic, expansion-only
 * occurrences — for example a post-meeting follow-up should fire at most once per series
 * rather than once per occurrence, and this is what lets it skip every occurrence but the one
 * that already existed before expansion did.
 */
export function isOccurrenceUid(uid: string): boolean {
  return /_\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(uid);
}

/**
 * Whether `rule` is inside the subset this module actually knows how to expand.
 *
 * BYSETPOS only means something paired with BYDAY on a MONTHLY rule ("the last Friday").
 * BYMONTHDAY only means something on a MONTHLY rule, and never alongside BYDAY (two
 * conflicting ways of picking the day). A bare MONTHLY+BYDAY with no BYSETPOS ("every Friday
 * of the month", i.e. several occurrences a month) is real RFC 5545 but outside what this
 * module was asked to support.
 *
 * Also rejects a BYMONTHDAY outside 1..31 (negative/"from the end of the month" values —
 * `-1` for "last day" — are real RFC 5545 but out of subset here) and a BYDAY code this
 * module doesn't know. Both matter beyond correctness: `monthlyByMonthDaySeries` and
 * `monthlySetPosSeries` walk forward a month at a time looking for a match, and a rule that
 * can never match would otherwise spin those generators forever with nothing to stop them —
 * this is the gate that keeps such a rule from ever reaching them.
 */
function isSupportedRule(rule: RecurrenceRule): boolean {
  const hasByDay = rule.byDay.length > 0;
  const hasByMonthDay = rule.byMonthDay.length > 0;
  const hasBySetPos = rule.bySetPos.length > 0;

  if (hasByDay && rule.byDay.some((d) => !(d in WEEKDAY_INDEX))) return false;
  if (hasByMonthDay && rule.byMonthDay.some((d) => d < 1 || d > 31)) return false;

  if (hasByMonthDay && hasByDay) return false;
  if (hasByMonthDay && rule.freq !== "MONTHLY") return false;
  if (hasBySetPos && !(rule.freq === "MONTHLY" && hasByDay && !hasByMonthDay)) return false;
  if (hasByDay && rule.freq !== "WEEKLY" && rule.freq !== "MONTHLY") return false;
  if (hasByDay && rule.freq === "MONTHLY" && !hasBySetPos) return false;
  return true;
}

function civilToUtcMs(c: Civil): number {
  return Date.UTC(c.y, c.mo - 1, c.d);
}
function utcMsToCivil(ms: number): Civil {
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

const DAY_MS = 86_400_000;

/**
 * Defense in depth for `monthlyByMonthDaySeries` / `monthlySetPosSeries`: `isSupportedRule`
 * should already keep a rule that can never match a day out of those generators, but a
 * generator that CAN spin forever on a bad rule is worse than one that gives up — 3 years of
 * consecutive empty months is well past any real "day N of the month" or "Nth weekday"
 * pattern ever going quiet that long.
 */
const MAX_EMPTY_MONTHLY_PERIODS = 36;

/** `{ y, mo }` stepped forward by `interval` months, carrying the year on 12-month overflow. */
function stepMonths(y: number, mo: number, interval: number): { y: number; mo: number } {
  let nextMo = mo + interval;
  let nextY = y;
  while (nextMo > 12) {
    nextMo -= 12;
    nextY++;
  }
  return { y: nextY, mo: nextMo };
}

function* dailySeries(rule: RecurrenceRule, start: Civil): Generator<Civil> {
  let anchor = civilToUtcMs(start);
  while (true) {
    yield utcMsToCivil(anchor);
    anchor += rule.interval * DAY_MS;
  }
}

function* weeklySimpleSeries(rule: RecurrenceRule, start: Civil): Generator<Civil> {
  let anchor = civilToUtcMs(start);
  while (true) {
    yield utcMsToCivil(anchor);
    anchor += rule.interval * 7 * DAY_MS;
  }
}

/** WEEKLY with an explicit BYDAY list: every listed weekday, in each `interval`-week bucket. */
function* weeklyByDaySeries(rule: RecurrenceRule, start: Civil): Generator<Civil> {
  const indices = [...new Set(rule.byDay.map((d) => WEEKDAY_INDEX[d]))]
    .filter((n): n is number => n !== undefined)
    .sort((a, b) => a - b);
  if (indices.length === 0) return;

  const startMs = civilToUtcMs(start);
  const startWeekday = new Date(startMs).getUTCDay();
  const weekStartMs = startMs - startWeekday * DAY_MS;

  let w = 0;
  while (true) {
    const bucketStart = weekStartMs + w * rule.interval * 7 * DAY_MS;
    for (const idx of indices) {
      const candidateMs = bucketStart + idx * DAY_MS;
      if (candidateMs < startMs) continue; // never emit before the master's own occurrence
      yield utcMsToCivil(candidateMs);
    }
    w++;
  }
}

/** MONTHLY with BYMONTHDAY: those day(s) of the month, every `interval` months. */
function* monthlyByMonthDaySeries(rule: RecurrenceRule, start: Civil): Generator<Civil> {
  const days = [...new Set(rule.byMonthDay)].sort((a, b) => a - b);
  const startMs = civilToUtcMs(start);
  let y = start.y;
  let mo = start.mo;
  let first = true;
  let emptyPeriods = 0;
  while (true) {
    let yielded = false;
    for (const day of days) {
      if (day < 1 || day > daysInMonth(y, mo)) continue;
      const candidateMs = Date.UTC(y, mo - 1, day);
      if (first && candidateMs < startMs) continue;
      yielded = true;
      yield { y, mo, d: day };
    }
    first = false;
    emptyPeriods = yielded ? 0 : emptyPeriods + 1;
    if (emptyPeriods > MAX_EMPTY_MONTHLY_PERIODS) return;
    ({ y, mo } = stepMonths(y, mo, rule.interval));
  }
}

/** MONTHLY with BYDAY + BYSETPOS: the Nth (or -1 = last) listed weekday of the month. */
function* monthlySetPosSeries(rule: RecurrenceRule, start: Civil): Generator<Civil> {
  const weekdayIndices = new Set(rule.byDay.map((d) => WEEKDAY_INDEX[d]).filter((n): n is number => n !== undefined));
  const startMs = civilToUtcMs(start);
  let y = start.y;
  let mo = start.mo;
  let first = true;
  let emptyPeriods = 0;
  while (true) {
    const matches: number[] = [];
    const total = daysInMonth(y, mo);
    for (let d = 1; d <= total; d++) {
      if (weekdayIndices.has(new Date(Date.UTC(y, mo - 1, d)).getUTCDay())) matches.push(d);
    }
    const selected = new Set<number>();
    for (const pos of rule.bySetPos) {
      const day = pos > 0 ? matches[pos - 1] : matches[matches.length + pos];
      if (day !== undefined) selected.add(day);
    }
    let yielded = false;
    for (const day of [...selected].sort((a, b) => a - b)) {
      const candidateMs = Date.UTC(y, mo - 1, day);
      if (first && candidateMs < startMs) continue;
      yielded = true;
      yield { y, mo, d: day };
    }
    first = false;
    emptyPeriods = yielded ? 0 : emptyPeriods + 1;
    // BYSETPOS values that a real month can never satisfy (e.g. BYSETPOS=6 — no month has a
    // 6th Friday) are a valid rule SHAPE, so isSupportedRule can't reject them by range the
    // way it does BYMONTHDAY. This bail-out is the actual guard for that case.
    if (emptyPeriods > MAX_EMPTY_MONTHLY_PERIODS) return;
    ({ y, mo } = stepMonths(y, mo, rule.interval));
  }
}

/** MONTHLY with no BY* rule: the same day-of-month as the master, skipping months too short. */
function* monthlySimpleSeries(rule: RecurrenceRule, start: Civil): Generator<Civil> {
  let y = start.y;
  let mo = start.mo;
  while (true) {
    if (start.d <= daysInMonth(y, mo)) yield { y, mo, d: start.d };
    ({ y, mo } = stepMonths(y, mo, rule.interval));
  }
}

/** YEARLY: the same month/day as the master, skipping years without it (Feb 29). */
function* yearlySimpleSeries(rule: RecurrenceRule, start: Civil): Generator<Civil> {
  let y = start.y;
  while (true) {
    if (start.d <= daysInMonth(y, start.mo)) yield { y, mo: start.mo, d: start.d };
    y += rule.interval;
  }
}

function civilDateSeries(rule: RecurrenceRule, start: Civil): Generator<Civil> {
  switch (rule.freq) {
    case "DAILY":
      return dailySeries(rule, start);
    case "WEEKLY":
      return rule.byDay.length > 0 ? weeklyByDaySeries(rule, start) : weeklySimpleSeries(rule, start);
    case "MONTHLY":
      if (rule.byMonthDay.length > 0) return monthlyByMonthDaySeries(rule, start);
      if (rule.byDay.length > 0 && rule.bySetPos.length > 0) return monthlySetPosSeries(rule, start);
      return monthlySimpleSeries(rule, start);
    case "YEARLY":
      return yearlySimpleSeries(rule, start);
  }
}

export function expandEvent(
  event: ParsedCalendarEvent,
  rule: RecurrenceRule | null,
  window: { from: Date; to: Date },
  opts: { exDates?: Date[]; cap?: number; overrides?: ParsedCalendarEvent[] } = {}
): ParsedCalendarEvent[] {
  // No rule, or no start: the event stands alone, uid untouched.
  if (!rule || !event.start) return [event];
  if (!isSupportedRule(rule)) return [event];

  const timezone = event.timezone ?? null;
  const wallStart = toWallClockInput(event.start, timezone);
  const startMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(wallStart);
  if (!startMatch) return [event];
  const start: Civil = { y: Number(startMatch[1]), mo: Number(startMatch[2]), d: Number(startMatch[3]) };
  const hh = Number(startMatch[4]);
  const mm = Number(startMatch[5]);

  const durationMs = event.end ? event.end.getTime() - event.start.getTime() : null;
  const cap = Math.max(0, Math.min(opts.cap ?? MAX_OCCURRENCES, MAX_OCCURRENCES));
  // A series whose DTSTART sits inside the window was, before expansion existed, already
  // ingested once as `cal:<uid>` — that's what a non-recurring event still writes today, and
  // recurring ones did too until RRULE was expanded. Ruling: the occurrence whose start
  // equals the master's own DTSTART keeps that bare id; only LATER occurrences (which never
  // had a stored row before expansion) get the `_<instant>` suffix. That preserves dedupe
  // against everything already ingested, and — via `isOccurrenceUid` — is what lets a
  // downstream consumer like a post-meeting reminder tell a series' one pre-existing
  // occurrence apart from the ones expansion synthesized.
  const masterMs = event.start.getTime();

  // EXDATE matches by exact instant, per RFC 5545. Task 3 builds these by parsing a real
  // EXDATE property through the same TZID-aware wall-clock resolution DTSTART gets, so by
  // the time a Date reaches here it is already the correct instant in the event's own zone —
  // no zone math needed at this end.
  const exDateTimes = new Set((opts.exDates ?? []).map((d) => d.getTime()));

  // Overrides: a VEVENT sharing this series' uid, carrying its own RECURRENCE-ID (the ORIGINAL
  // scheduled instant it replaces, not its own possibly-moved start) and no RRULE of its own.
  // Keyed by that original instant so the loop below can substitute one in place, by identity,
  // as it reaches the candidate it replaces — never emitted as an independent event, and never
  // duplicating the occurrence it overrides.
  const overrideByInstant = new Map<number, ParsedCalendarEvent>();
  for (const override of opts.overrides ?? []) {
    if (override.recurrenceId) overrideByInstant.set(override.recurrenceId.getTime(), override);
  }

  const results: ParsedCalendarEvent[] = [];
  // RFC 5545's COUNT tallies every candidate from DTSTART onward, regardless of the window —
  // it must NOT share a counter with the emit cap below. Coupling them used to mean a daily
  // standup that started well before `window.from` burned its cap on candidates the window
  // would drop anyway, leaving nothing (or nothing FUTURE) by the time the series reached
  // `window.from` at all.
  let count = 0;
  // A candidate earlier than `window.from` is skipped (`continue`, not counted against the
  // cap), so nothing bounds how many such candidates a runaway-old DTSTART produces on its
  // own — `dailySeries`/`weeklySimpleSeries`/`weeklyByDaySeries` are unconditional `while
  // (true)` generators with no bail-out of their own. This is that bound: independent of the
  // emit cap, so a 1970 DTSTART can't spin `fromWallClockInput` tens of thousands of times
  // before either the cap or `window.to` ever gets a chance to stop it.
  const MAX_CANDIDATE_ITERATIONS = 50_000;
  let iterations = 0;
  for (const civil of civilDateSeries(rule, start)) {
    if (results.length >= cap) break;
    if (++iterations > MAX_CANDIDATE_ITERATIONS) break;

    const wall = `${civilKey(civil)}T${pad2(hh)}:${pad2(mm)}`;
    const instant = fromWallClockInput(wall, timezone);
    if (!instant) continue;

    if (rule.until && instant.getTime() > rule.until.getTime()) break;
    if (instant.getTime() >= window.to.getTime()) break; // dates only increase from here on

    count++;
    if (rule.count !== null && count > rule.count) break;

    if (instant.getTime() < window.from.getTime()) continue;
    if (exDateTimes.has(instant.getTime())) continue;

    // The id is always keyed to the ORIGINAL scheduled instant — the slot in the series this
    // occurrence occupies — regardless of whether an override moved its actual time. That is
    // what "keeping the id of the occurrence it replaces" means: a rescheduled instance must
    // dedupe against, and only against, the row already ingested for the slot it replaced.
    const uid = instant.getTime() === masterMs ? event.uid : occurrenceUid(event.uid, instant);
    const override = overrideByInstant.get(instant.getTime());

    if (override) {
      // Substitute the override's own time/summary/attendees wholesale, but keep the id the
      // occurrence it replaces would have had. `rrule`/`exDates`/`recurrenceId` are cleared: the
      // emitted row is a plain occurrence now, not a rule-bearer.
      results.push({ ...override, uid, rrule: null, exDates: null, recurrenceId: null });
      continue;
    }

    results.push({
      ...event,
      start: instant,
      end: durationMs !== null ? new Date(instant.getTime() + durationMs) : event.end,
      uid,
    });
  }

  return results;
}

/**
 * Expand every event a parsed ICS document/feed produced, honouring RECURRENCE-ID overrides.
 *
 * `parseIcsEvents` returns one `ParsedCalendarEvent` per VEVENT block, and a recurring series
 * with a rescheduled instance is TWO such blocks sharing one `uid`: a master (RRULE, no
 * RECURRENCE-ID) and an override (RECURRENCE-ID, no RRULE — the moved time, and usually a
 * changed summary/attendees). Calling `expandEvent` on each block independently is wrong: the
 * override would surface as its own extra event at the moved time, while the master's expansion
 * still emits an untouched occurrence at the slot the override replaces — two rows for one
 * meeting, one of them stale, and (worse) both wanting the SAME id when the override happens to
 * fall on the series' own DTSTART.
 *
 * So events are grouped by uid first. The one event per uid that carries no `recurrenceId` is
 * that series' master (a plain, non-recurring event is simply a series of one — `expandEvent`
 * already returns that unchanged); every other event sharing the uid is handed to `expandEvent`
 * as an override, which substitutes it in place of the occurrence it replaces rather than
 * emitting it a second time. An override whose uid matches no master in this batch — the master
 * fell outside whatever page or CalDAV resource produced this batch — has nothing to attach to;
 * it is still a real meeting that happened, so it is emitted standalone rather than dropped.
 */
export function expandIcsEvents(
  parsedEvents: ParsedCalendarEvent[],
  window: { from: Date; to: Date },
  opts: { cap?: number } = {}
): ParsedCalendarEvent[] {
  const masters = new Map<string, ParsedCalendarEvent>();
  const overridesByUid = new Map<string, ParsedCalendarEvent[]>();
  // Two non-override blocks sharing a uid is a malformed feed (real ICS never does this) — the
  // first is kept as the series' master and any later one stands alone rather than being
  // silently dropped.
  const standalone: ParsedCalendarEvent[] = [];

  for (const event of parsedEvents) {
    if (event.recurrenceId) {
      const list = overridesByUid.get(event.uid);
      if (list) list.push(event);
      else overridesByUid.set(event.uid, [event]);
      continue;
    }
    if (!masters.has(event.uid)) masters.set(event.uid, event);
    else standalone.push(event);
  }

  const out: ParsedCalendarEvent[] = [...standalone];
  for (const [uid, master] of masters) {
    const overrides = overridesByUid.get(uid) ?? [];
    overridesByUid.delete(uid);
    const rule = master.rrule ? parseRRule(`RRULE:${master.rrule}`) : null;
    out.push(
      ...expandEvent(master, rule, window, {
        exDates: master.exDates ?? undefined,
        overrides,
        cap: opts.cap,
      })
    );
  }
  // Real overrides whose uid matched no master in this batch — see the function's own comment.
  for (const leftover of overridesByUid.values()) out.push(...leftover);

  return out;
}
