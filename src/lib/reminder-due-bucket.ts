/**
 * Which calendar day a reminder is due, and how that day relates to today — the one
 * definition the reminders query, its rail counts and every row label share.
 *
 * Before this existed the card called anything with `due <= now` overdue while the server
 * sorted on server-local start-of-day, so a reminder due at 9am today read "Overdue 1 day"
 * in a row the server had filed under today.
 *
 * Two rules carry the weight:
 *
 *   - "Today" is the VIEWER's day. No timezone is stored per user, so the browser's IANA
 *     zone travels in the `orbit-tz` cookie (`TZ_COOKIE`) and falls back to UTC.
 *   - A date-only value is a floating date, not an instant. The codebase stores those two
 *     ways — UTC midnight (`new Date("YYYY-MM-DD")`, e.g. `createReminder`) and noon
 *     (`atLocalNoon`, on a UTC server) — the same pair `isDateOnly` in `calendar-feed.ts`
 *     recognizes. Read in New York, UTC midnight on the 18th is 8pm on the 17th, so
 *     converting it into the viewer's zone would file it a day early. Its day is its UTC
 *     date. Only a timed value is converted.
 *
 * `reminders-page-query.ts` expresses the same rule in SQL (`dueDaySql`); the smoke test
 * `smoke-reminder-due-bucket.ts` holds the two in agreement.
 *
 * Pure and dependency-free: imported by client rows as well as the server.
 */

export type DueBucket = "overdue" | "today" | "tomorrow" | "week" | "later" | "none";

/** Cookie carrying the viewer's IANA timezone. Written by the reminders stage. */
export const TZ_COOKIE = "orbit-tz";
export const DEFAULT_TZ = "UTC";

/** Bucket order, for grouping headers. */
export const DUE_BUCKETS: readonly DueBucket[] = [
  "overdue",
  "today",
  "tomorrow",
  "week",
  "later",
  "none",
];

export const DUE_BUCKET_LABELS: Record<DueBucket, string> = {
  overdue: "Overdue",
  today: "Today",
  tomorrow: "Tomorrow",
  week: "Next 7 days",
  later: "Later",
  none: "No date",
};

/**
 * Whether `tz` is an IANA zone this runtime knows. The value reaches Postgres as an
 * `AT TIME ZONE` operand, so anything unrecognized must be refused here, not there.
 */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  if (!/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function resolveTimeZone(raw: string | null | undefined): string {
  return isValidTimeZone(raw) ? raw : DEFAULT_TZ;
}

const ymdFormatters = new Map<string, Intl.DateTimeFormat>();

/** `d`'s calendar day in `tz`, as YYYY-MM-DD. */
export function ymdInZone(d: Date, tz: string): string {
  let fmt = ymdFormatters.get(tz);
  if (!fmt) {
    // en-CA formats as YYYY-MM-DD.
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    ymdFormatters.set(tz, fmt);
  }
  return fmt.format(d);
}

function utcYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** UTC midnight or UTC noon, exactly — the two date-only storage conventions. */
export function isDateOnlyDue(d: Date): boolean {
  if (d.getUTCMinutes() !== 0 || d.getUTCSeconds() !== 0 || d.getUTCMilliseconds() !== 0) {
    return false;
  }
  const h = d.getUTCHours();
  return h === 0 || h === 12;
}

/** The calendar day a reminder is due, as the viewer in `tz` would read it. */
export function dueDayOf(
  due: Date | string | null | undefined,
  tz: string
): string | null {
  if (!due) return null;
  const d = due instanceof Date ? due : new Date(due);
  if (Number.isNaN(d.getTime())) return null;
  return isDateOnlyDue(d) ? utcYmd(d) : ymdInZone(d, tz);
}

function ymdToUtc(ymd: string): Date {
  return new Date(`${ymd}T00:00:00Z`);
}

export function addDaysYmd(ymd: string, days: number): string {
  const d = ymdToUtc(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return utcYmd(d);
}

/** Whole days from `from` to `to` (both YYYY-MM-DD); negative when `to` is earlier. */
export function daysBetweenYmd(from: string, to: string): number {
  return Math.round((ymdToUtc(to).getTime() - ymdToUtc(from).getTime()) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOfYmd(ymd: string): number {
  return ymdToUtc(ymd).getUTCDay();
}

export function bucketForDay(dueDay: string | null, today: string): DueBucket {
  if (!dueDay) return "none";
  // YYYY-MM-DD compares correctly as a string.
  if (dueDay < today) return "overdue";
  if (dueDay === today) return "today";
  if (dueDay === addDaysYmd(today, 1)) return "tomorrow";
  if (dueDay <= addDaysYmd(today, 7)) return "week";
  return "later";
}

/**
 * The snooze menu's presets, as days. "This weekend" is the coming Saturday — Sunday when
 * it is already Saturday. "Next week" is the coming Monday.
 */
export function snoozePresets(today: string): {
  tomorrow: string;
  weekend: string;
  nextWeek: string;
} {
  const dow = weekdayOfYmd(today);
  const toSaturday = dow === 6 ? 1 : (6 - dow + 7) % 7 || 7;
  const toMonday = (1 - dow + 7) % 7 || 7;
  return {
    tomorrow: addDaysYmd(today, 1),
    weekend: addDaysYmd(today, toSaturday),
    nextWeek: addDaysYmd(today, toMonday),
  };
}

const shortDayFmt = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const shortDayYearFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** "Sat, Sep 26" — a day on its own, for menus and toasts. */
export function shortDayLabel(ymd: string): string {
  return shortDayFmt.format(ymdToUtc(ymd));
}

/** A row's due text: "Today", "Tomorrow", "Overdue 3 days", "Fri, Sep 26". */
export function dueLabelFor(
  dueDay: string | null,
  today: string
): { text: string; bucket: DueBucket } | null {
  if (!dueDay) return null;
  const bucket = bucketForDay(dueDay, today);
  if (bucket === "overdue") {
    const days = -daysBetweenYmd(today, dueDay);
    return { text: days === 1 ? "Yesterday" : `Overdue ${days} days`, bucket };
  }
  if (bucket === "today") return { text: "Today", bucket };
  if (bucket === "tomorrow") return { text: "Tomorrow", bucket };
  const sameYear = dueDay.slice(0, 4) === today.slice(0, 4);
  return {
    text: (sameYear ? shortDayFmt : shortDayYearFmt).format(ymdToUtc(dueDay)),
    bucket,
  };
}
