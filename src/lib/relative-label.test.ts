/**
 * Characterization of every relative-time label in the app, written BEFORE they were
 * consolidated into `src/lib/relative-date.ts` (CODE_HEALTH_PLAN P4.5).
 *
 * The `legacy*` functions are the original module-private bodies, copied verbatim (they read
 * `Date.now()`, which the tests pin). The shared formatters must reproduce each of them for
 * the format that call site uses, including the quirks (`-5m` for a future date, `NaNy` for an
 * invalid one, the 24h vs 48h day cut-over).
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { formatDistance, formatDistanceToNow } from "date-fns";
import {
  longRelativeLabel,
  minutesAgoLabel,
  relativeLabel,
  shortRelativeLabel,
} from "@/lib/relative-date";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const D = 24 * H;

// ---- legacy copies (verbatim) ---------------------------------------------------------

/** src/components/admin/relative-time.tsx `relativeLabel` */
function legacyAdminRelativeLabel(d: Date): string {
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60_000);
  if (Math.abs(mins) < 1) return "just now";
  if (Math.abs(mins) < 60) return `${mins}m`;

  const hours = Math.round(diff / 3_600_000);
  if (Math.abs(hours) < 24) return `${hours}h`;

  const days = Math.round(diff / 86_400_000);
  if (Math.abs(days) < 365) return `${days}d`;

  return `${Math.round(days / 365)}y`;
}

/** src/components/admin/health-live.tsx `relativeMinutes` */
function legacyRelativeMinutes(date: Date | string) {
  const d = typeof date === "string" ? new Date(date) : date;
  const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** src/components/admin/interest-list-table.tsx `relativeAgoLabel` */
function legacyRelativeAgoLabel(d: Date): string {
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60_000);
  if (Math.abs(mins) < 1) return "just now";
  if (Math.abs(mins) < 60) return `${mins}m ago`;
  const hours = Math.round(diff / 3_600_000);
  if (Math.abs(hours) < 24) return `${hours}h ago`;
  const days = Math.round(diff / 86_400_000);
  if (Math.abs(days) < 365) return `${days}d ago`;
  return `${Math.round(days / 365)}y ago`;
}

/** src/components/graph/contact-inspect-panel.tsx `formatMaybeRelative` */
function legacyFormatMaybeRelative(value: string | null | undefined) {
  if (!value) return null;
  try {
    return formatDistanceToNow(new Date(value), { addSuffix: true });
  } catch {
    return null;
  }
}

// ---- the table ------------------------------------------------------------------------

/** [name, milliseconds BEFORE now (negative = in the future)] */
const DELTAS: Array<[string, number]> = [
  ["equal", 0],
  ["1s", 1 * S],
  ["29s", 29 * S],
  ["30s", 30 * S],
  ["59s", 59 * S],
  ["60s", 60 * S],
  ["89s", 89 * S],
  ["90s", 90 * S],
  ["5min", 5 * MIN],
  ["44min", 44 * MIN],
  ["59min", 59 * MIN],
  ["59.5min", 59.5 * MIN],
  ["60min", 60 * MIN],
  ["89min", 89 * MIN],
  ["90min", 90 * MIN],
  ["3h", 3 * H],
  ["23h", 23 * H],
  ["23.5h", 23.5 * H],
  ["24h", 24 * H],
  ["36h", 36 * H],
  ["47h", 47 * H],
  ["47.5h", 47.5 * H],
  ["48h", 48 * H],
  ["3d", 3 * D],
  ["6d", 6 * D],
  ["7d", 7 * D],
  ["13d", 13 * D],
  ["30d", 30 * D],
  ["45d", 45 * D],
  ["90d", 90 * D],
  ["364d", 364 * D],
  ["364.5d", 364.5 * D],
  ["365d", 365 * D],
  ["547d", 547 * D],
  ["548d", 548 * D],
  ["730d", 730 * D],
  ["1000d", 1000 * D],
  ["future 30s", -30 * S],
  ["future 5min", -5 * MIN],
  ["future 59min", -59 * MIN],
  ["future 3h", -3 * H],
  ["future 30h", -30 * H],
  ["future 2d", -2 * D],
  ["future 40d", -40 * D],
  ["future 400d", -400 * D],
];

const at = (msBefore: number) => new Date(NOW.getTime() - msBefore);

/** Pinned outputs, captured from the legacy functions above. */
const EXPECTED: Record<string, { admin: string; ago: string; minutes: string; long: string }> = {
  "equal": { admin: "just now", ago: "just now", minutes: "just now", long: "less than a minute ago" },
  "1s": { admin: "just now", ago: "just now", minutes: "just now", long: "less than a minute ago" },
  "29s": { admin: "just now", ago: "just now", minutes: "just now", long: "less than a minute ago" },
  "30s": { admin: "1m", ago: "1m ago", minutes: "1 min ago", long: "1 minute ago" },
  "59s": { admin: "1m", ago: "1m ago", minutes: "1 min ago", long: "1 minute ago" },
  "60s": { admin: "1m", ago: "1m ago", minutes: "1 min ago", long: "1 minute ago" },
  "89s": { admin: "1m", ago: "1m ago", minutes: "1 min ago", long: "1 minute ago" },
  "90s": { admin: "2m", ago: "2m ago", minutes: "2 min ago", long: "2 minutes ago" },
  "5min": { admin: "5m", ago: "5m ago", minutes: "5 min ago", long: "5 minutes ago" },
  "44min": { admin: "44m", ago: "44m ago", minutes: "44 min ago", long: "44 minutes ago" },
  "59min": { admin: "59m", ago: "59m ago", minutes: "59 min ago", long: "about 1 hour ago" },
  "59.5min": { admin: "1h", ago: "1h ago", minutes: "1 h ago", long: "about 1 hour ago" },
  "60min": { admin: "1h", ago: "1h ago", minutes: "1 h ago", long: "about 1 hour ago" },
  "89min": { admin: "1h", ago: "1h ago", minutes: "1 h ago", long: "about 1 hour ago" },
  "90min": { admin: "2h", ago: "2h ago", minutes: "2 h ago", long: "about 2 hours ago" },
  "3h": { admin: "3h", ago: "3h ago", minutes: "3 h ago", long: "about 3 hours ago" },
  "23h": { admin: "23h", ago: "23h ago", minutes: "23 h ago", long: "about 23 hours ago" },
  "23.5h": { admin: "1d", ago: "1d ago", minutes: "24 h ago", long: "about 24 hours ago" },
  "24h": { admin: "1d", ago: "1d ago", minutes: "24 h ago", long: "1 day ago" },
  "36h": { admin: "2d", ago: "2d ago", minutes: "36 h ago", long: "1 day ago" },
  "47h": { admin: "2d", ago: "2d ago", minutes: "47 h ago", long: "2 days ago" },
  "47.5h": { admin: "2d", ago: "2d ago", minutes: "2 d ago", long: "2 days ago" },
  "48h": { admin: "2d", ago: "2d ago", minutes: "2 d ago", long: "2 days ago" },
  "3d": { admin: "3d", ago: "3d ago", minutes: "3 d ago", long: "3 days ago" },
  "6d": { admin: "6d", ago: "6d ago", minutes: "6 d ago", long: "6 days ago" },
  "7d": { admin: "7d", ago: "7d ago", minutes: "7 d ago", long: "7 days ago" },
  "13d": { admin: "13d", ago: "13d ago", minutes: "13 d ago", long: "13 days ago" },
  "30d": { admin: "30d", ago: "30d ago", minutes: "30 d ago", long: "about 1 month ago" },
  "45d": { admin: "45d", ago: "45d ago", minutes: "45 d ago", long: "about 2 months ago" },
  "90d": { admin: "90d", ago: "90d ago", minutes: "90 d ago", long: "3 months ago" },
  "364d": { admin: "364d", ago: "364d ago", minutes: "364 d ago", long: "12 months ago" },
  "364.5d": { admin: "1y", ago: "1y ago", minutes: "365 d ago", long: "12 months ago" },
  "365d": { admin: "1y", ago: "1y ago", minutes: "365 d ago", long: "about 1 year ago" },
  "547d": { admin: "1y", ago: "1y ago", minutes: "547 d ago", long: "over 1 year ago" },
  "548d": { admin: "2y", ago: "2y ago", minutes: "548 d ago", long: "over 1 year ago" },
  "730d": { admin: "2y", ago: "2y ago", minutes: "730 d ago", long: "about 2 years ago" },
  "1000d": { admin: "3y", ago: "3y ago", minutes: "1000 d ago", long: "over 2 years ago" },
  "future 30s": { admin: "just now", ago: "just now", minutes: "just now", long: "in 1 minute" },
  "future 5min": { admin: "-5m", ago: "-5m ago", minutes: "just now", long: "in 5 minutes" },
  "future 59min": { admin: "-59m", ago: "-59m ago", minutes: "just now", long: "in about 1 hour" },
  "future 3h": { admin: "-3h", ago: "-3h ago", minutes: "just now", long: "in about 3 hours" },
  "future 30h": { admin: "-1d", ago: "-1d ago", minutes: "just now", long: "in 1 day" },
  "future 2d": { admin: "-2d", ago: "-2d ago", minutes: "just now", long: "in 2 days" },
  "future 40d": { admin: "-40d", ago: "-40d ago", minutes: "just now", long: "in about 1 month" },
  "future 400d": { admin: "-1y", ago: "-1y ago", minutes: "just now", long: "in about 1 year" },
};

describe("relative labels: legacy behaviour is pinned", () => {
  for (const [name, ms] of DELTAS) {
    it(`legacy: ${name}`, () => {
      mock.method(Date, "now", () => NOW.getTime());
      try {
        const d = at(ms);
        const got = {
          admin: legacyAdminRelativeLabel(d),
          ago: legacyRelativeAgoLabel(d),
          minutes: legacyRelativeMinutes(d),
          long: legacyFormatMaybeRelative(d.toISOString()) ?? "null",
        };
        if (process.env.PRINT_TABLE) console.log(JSON.stringify([name, got]));
        assert.deepEqual(got, EXPECTED[name]);
      } finally {
        mock.restoreAll();
      }
    });
  }
});

describe("relative labels: invalid input", () => {
  const bad = new Date("not a date");

  it("legacy outputs", () => {
    mock.method(Date, "now", () => NOW.getTime());
    try {
      assert.equal(legacyAdminRelativeLabel(bad), "NaNy");
      assert.equal(legacyRelativeAgoLabel(bad), "NaNy ago");
      assert.equal(legacyRelativeMinutes(bad), "NaN d ago");
      assert.equal(legacyFormatMaybeRelative("not a date"), null);
      assert.equal(legacyFormatMaybeRelative(""), null);
      assert.equal(legacyFormatMaybeRelative(null), null);
    } finally {
      mock.restoreAll();
    }
  });

  it("shared formatters reproduce them", () => {
    assert.equal(shortRelativeLabel(bad, NOW), "NaNy");
    assert.equal(shortRelativeLabel(bad, NOW, { ago: true }), "NaNy ago");
    assert.equal(minutesAgoLabel(bad, NOW), "NaN d ago");
    assert.throws(() => longRelativeLabel(bad, NOW), RangeError);
  });
});

describe("relative labels: shared formatters match every legacy copy at a fixed now", () => {
  for (const [name, ms] of DELTAS) {
    it(name, () => {
      const d = at(ms);
      const want = EXPECTED[name];
      assert.equal(shortRelativeLabel(d, NOW), want.admin);
      assert.equal(relativeLabel(d, NOW, "short"), want.admin);
      assert.equal(shortRelativeLabel(d, NOW, { ago: true }), want.ago);
      assert.equal(minutesAgoLabel(d, NOW), want.minutes);
      assert.equal(longRelativeLabel(d, NOW), want.long);
      assert.equal(relativeLabel(d, NOW, "long"), want.long);
      // date-fns as the call sites use it (formatDistance with an explicit now).
      assert.equal(formatDistance(d, NOW, { addSuffix: true }), want.long);
    });
  }

  it("defaults `now` to the clock", () => {
    mock.timers.enable({ apis: ["Date"], now: NOW });
    try {
      assert.equal(shortRelativeLabel(at(3 * H)), "3h");
      assert.equal(longRelativeLabel(at(3 * H)), "about 3 hours ago");
    } finally {
      mock.timers.reset();
    }
  });
});

describe("relative labels: the copies disagree on these boundaries (kept as separate formatters)", () => {
  it("24h to 47h: short says days, minutesAgoLabel keeps hours", () => {
    assert.equal(shortRelativeLabel(at(30 * H), NOW), "1d");
    assert.equal(minutesAgoLabel(at(30 * H), NOW), "30 h ago");
  });
  it("the future: short shows a negative, minutesAgoLabel clamps", () => {
    assert.equal(shortRelativeLabel(at(-5 * MIN), NOW), "-5m");
    assert.equal(minutesAgoLabel(at(-5 * MIN), NOW), "just now");
  });
});
