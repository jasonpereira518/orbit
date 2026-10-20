/**
 * Characterization of the day-math helpers consolidated into `lib/dates.ts` (plan P4.5).
 * The `LEGACY_*` bodies are the pre-migration copies, verbatim; each helper is compared with
 * them across DST boundaries in several zones. Rounding (floor vs round) and UTC vs local are
 * deliberately NOT unified: they have different names.
 */
import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { addLocalDaysAtNoon, addUtcDays, daysBetweenFloor, startOfLocalDay } from "@/lib/dates";
import { atLocalNoon } from "@/lib/interaction-date";

const DAY_MS = 86_400_000;

/** cadence-phrase.ts:140 and relative-date.ts:46 (identical) */
function legacyAddDaysLocal(d: Date, n: number) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return atLocalNoon(out);
}
/** ics.ts:78 */
function legacyAddDaysUtc(d: Date, days: number) {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}
/** keep-in-touch.ts:68 */
function legacyKeepInTouch(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}
/** radar/score.ts:220 */
function legacyRadar(later: Date, earlier: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / DAY_MS);
}
/** opportunity-extract.ts:80 and date-commitment-extract.ts:276 */
function legacyStartOfDaySetHours(d: Date) {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}
/** chat-history-groups.ts:25 */
function legacyStartOfDayNumber(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const ZONES: Array<[string, string[]]> = [
  ["UTC", ["2026-03-08T12:00:00Z", "2026-11-01T12:00:00Z"]],
  ["America/New_York", ["2026-03-07T20:00:00Z", "2026-03-08T06:59:59Z", "2026-03-08T07:00:00Z", "2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"]],
  ["Europe/London", ["2026-03-29T00:30:00Z", "2026-03-29T01:00:00Z", "2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z"]],
  ["Australia/Lord_Howe", ["2026-04-04T13:00:00Z", "2026-10-03T14:30:00Z"]], // 30-minute DST shift
  ["America/Sao_Paulo", ["2018-11-04T02:30:00Z", "2018-11-04T03:00:00Z", "2019-02-16T23:30:00Z"]], // midnight DST gap
  ["Pacific/Auckland", ["2026-09-26T11:00:00Z", "2026-04-04T14:30:00Z"]],
];

const origTz = process.env.TZ;
after(() => {
  if (origTz === undefined) delete process.env.TZ;
  else process.env.TZ = origTz;
});

function sameInstant(a: Date, b: Date, msg: string) {
  assert.equal(a.getTime(), b.getTime(), msg);
}

for (const [tz, instants] of ZONES) {
  describe(`day math in ${tz}`, () => {
    for (const iso of instants) {
      const d = new Date(iso);
      it(`${iso}`, () => {
        process.env.TZ = tz;
        for (const n of [-400, -31, -1, 0, 1, 2, 7, 30, 31, 183, 365]) {
          sameInstant(addLocalDaysAtNoon(d, n), legacyAddDaysLocal(d, n), `addLocalDaysAtNoon ${n}`);
          sameInstant(addUtcDays(d, n), legacyAddDaysUtc(d, n), `addUtcDays ${n}`);
          const other = new Date(d.getTime() + n * DAY_MS + 3_600_000 * 7);
          assert.equal(daysBetweenFloor(d, other), legacyKeepInTouch(d, other), `floor ${n}`);
          assert.equal(daysBetweenFloor(d, other), legacyRadar(other, d), `floor radar ${n}`);
        }
        sameInstant(startOfLocalDay(d), legacyStartOfDaySetHours(d), "startOfLocalDay vs setHours");
        assert.equal(startOfLocalDay(d).getTime(), legacyStartOfDayNumber(d));
      });
    }
  });
}

describe("rounding is floor, not round", () => {
  it("23h is 0 days, 47h is 1 day, -1h is -1 day", () => {
    const a = new Date("2026-06-01T00:00:00Z");
    assert.equal(daysBetweenFloor(a, new Date(a.getTime() + 23 * 3_600_000)), 0);
    assert.equal(daysBetweenFloor(a, new Date(a.getTime() + 47 * 3_600_000)), 1);
    assert.equal(daysBetweenFloor(a, new Date(a.getTime() - 3_600_000)), -1);
  });
  it("addUtcDays keeps the time of day; addLocalDaysAtNoon pins noon", () => {
    process.env.TZ = "UTC";
    const d = new Date("2026-06-01T08:15:00Z");
    assert.equal(addUtcDays(d, 1).toISOString(), "2026-06-02T08:15:00.000Z");
    assert.equal(addLocalDaysAtNoon(d, 1).toISOString(), "2026-06-02T12:00:00.000Z");
  });
});
