/**
 * Parse an interaction date from note text.
 * Prefers explicit dates; resolves relative phrases against a reference date.
 */

const MONTHS: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

function atLocalNoon(d: Date) {
  const out = new Date(d);
  out.setHours(12, 0, 0, 0);
  return out;
}

function nextWeekday(from: Date, weekday: number) {
  const out = new Date(from);
  const delta = (weekday - out.getDay() + 7) % 7 || 7;
  out.setDate(out.getDate() + delta);
  return atLocalNoon(out);
}

/**
 * Extract a date from free-text notes. Returns null if nothing reliable is found.
 */
export function parseInteractionDateFromNotes(
  notes: string | null | undefined,
  referenceDate: Date = new Date()
): Date | null {
  const text = (notes || "").trim();
  if (!text) return null;
  const ref = atLocalNoon(referenceDate);
  const lower = text.toLowerCase();

  // ISO / numeric: 2024-03-15, 3/15/2024, 15/3/2024
  const iso = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    const d = new Date(
      Number(iso[1]),
      Number(iso[2]) - 1,
      Number(iso[3]),
      12,
      0,
      0,
      0
    );
    if (!Number.isNaN(d.getTime())) return d;
  }

  const us = text.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (us) {
    const d = new Date(
      Number(us[3]),
      Number(us[1]) - 1,
      Number(us[2]),
      12,
      0,
      0,
      0
    );
    if (!Number.isNaN(d.getTime())) return d;
  }

  // Month Day, Year / Month Day
  const monthDay = lower.match(
    /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(20\d{2}))?\b/i
  );
  if (monthDay) {
    const month = MONTHS[monthDay[1].toLowerCase()];
    const day = Number(monthDay[2]);
    const year = monthDay[3] ? Number(monthDay[3]) : ref.getFullYear();
    if (month != null && day >= 1 && day <= 31) {
      const d = new Date(year, month, day, 12, 0, 0, 0);
      if (!Number.isNaN(d.getTime())) {
        // If no year and date is >30 days in the future, assume previous year
        if (!monthDay[3] && d.getTime() - ref.getTime() > 30 * 86400000) {
          d.setFullYear(year - 1);
        }
        return d;
      }
    }
  }

  if (/\btoday\b/.test(lower)) return atLocalNoon(ref);
  if (/\byesterday\b/.test(lower)) {
    const d = new Date(ref);
    d.setDate(d.getDate() - 1);
    return atLocalNoon(d);
  }
  if (/\btomorrow\b/.test(lower)) {
    const d = new Date(ref);
    d.setDate(d.getDate() + 1);
    return atLocalNoon(d);
  }

  const daysAgo = lower.match(/\b(\d+)\s+days?\s+ago\b/);
  if (daysAgo) {
    const d = new Date(ref);
    d.setDate(d.getDate() - Number(daysAgo[1]));
    return atLocalNoon(d);
  }

  const nextWd = lower.match(
    /\bnext\s+(sunday|sun|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat)\b/
  );
  if (nextWd) {
    const wd = WEEKDAYS[nextWd[1].toLowerCase()];
    if (wd != null) return nextWeekday(ref, wd);
  }

  const thisWd = lower.match(
    /\b(?:this|on)\s+(sunday|sun|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat)\b/
  );
  if (thisWd) {
    const wd = WEEKDAYS[thisWd[1].toLowerCase()];
    if (wd != null) {
      const out = new Date(ref);
      const delta = (wd - out.getDay() + 7) % 7;
      out.setDate(out.getDate() + delta);
      return atLocalNoon(out);
    }
  }

  return null;
}
