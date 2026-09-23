/**
 * The LinkedIn data export, as onboarding and the reminder both describe it.
 *
 * Onboarding sends people to LinkedIn's "Download larger data archive" at step 2, because
 * the archive takes up to a day and nothing else in setup does. A day later the first page
 * load shows a full-screen "Is your LinkedIn export ready?" reminder, once; after that a
 * quiet dashboard card carries the same two links until the export is uploaded.
 *
 * Pure — no `next/*`, no `@/db` — because the client stage, the server layout and the smoke
 * script all read these rules. The database half lives in `src/lib/linkedin-reminder.ts`.
 */

/** LinkedIn's own "Download your data" page — the direct link, past Me → Settings. */
export const LINKEDIN_DATA_URL = "https://www.linkedin.com/mypreferences/d/download-my-data";

/** The subject LinkedIn sends the finished archive under. Quoted in copy, not searched on. */
export const LINKEDIN_ARCHIVE_EMAIL_SUBJECT = "Your full LinkedIn data archive is ready!";

/** How long LinkedIn keeps the download link alive after that email arrives. */
export const LINKEDIN_ARCHIVE_LINK_HOURS = 72;

const DAY_MS = 24 * 60 * 60 * 1000;

/** "The first login after 24 hours after the first login ever." */
export const LINKEDIN_REMINDER_MIN_AGE_MS = DAY_MS;

/**
 * Past this the reminder is never shown. Its question only makes sense in the days after
 * sign-up; without a ceiling, shipping this would throw the screen at every existing
 * account that never imported LinkedIn, most of which were never told to request it.
 */
export const LINKEDIN_REMINDER_MAX_AGE_MS = 14 * DAY_MS;

/** How long the quieter dashboard card keeps asking once the reminder has had its turn. */
export const LINKEDIN_NUDGE_MAX_AGE_MS = 30 * DAY_MS;

type Instant = Date | string | null | undefined;

function ms(value: Instant): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

function accountAgeMs(createdAt: Instant, now: Date): number | null {
  const created = ms(createdAt);
  return created == null ? null : now.getTime() - created;
}

/**
 * The half of eligibility that needs nothing but the `user_settings` row. The server
 * checks this first so the `imports` lookup only runs inside the 24h–14d window, which
 * is what keeps the reminder free on every other page load.
 */
export function isLinkedInReminderWindowOpen(input: {
  createdAt: Instant;
  shownAt: Instant;
  now: Date;
}): boolean {
  if (ms(input.shownAt) != null) return false;
  const age = accountAgeMs(input.createdAt, input.now);
  return age != null && age >= LINKEDIN_REMINDER_MIN_AGE_MS && age <= LINKEDIN_REMINDER_MAX_AGE_MS;
}

/** Whether this page load owes the full-screen reminder. */
export function isLinkedInReminderDue(input: {
  createdAt: Instant;
  shownAt: Instant;
  hasLinkedInImport: boolean;
  now: Date;
}): boolean {
  return !input.hasLinkedInImport && isLinkedInReminderWindowOpen(input);
}

/**
 * The dashboard card. It waits for the reminder (or an explicit request) so a brand-new
 * account's dashboard does not open on a chore, then stays until the upload lands.
 */
export function isLinkedInNudgeVisible(input: {
  createdAt: Instant;
  shownAt: Instant;
  requestedAt: Instant;
  hasLinkedInImport: boolean;
  now: Date;
}): boolean {
  if (input.hasLinkedInImport) return false;
  if (ms(input.shownAt) == null && ms(input.requestedAt) == null) return false;
  const age = accountAgeMs(input.createdAt, input.now);
  return age != null && age <= LINKEDIN_NUDGE_MAX_AGE_MS;
}
