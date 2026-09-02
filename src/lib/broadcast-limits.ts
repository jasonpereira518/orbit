/**
 * Composer limits, shared by the client form and the server validator.
 *
 * Deliberately NOT in `src/lib/broadcasts.ts`: that module reaches the database and the
 * Resend SDK, so a client component importing a constant from it would pull PGlite — and
 * therefore `node:fs` — into the browser bundle and fail the build. Same split, and the
 * same reason, as `contact-message.ts` against `actions/contact.ts`.
 */

export const SUBJECT_MAX = 120;
export const BODY_MAX = 8000;
export const SUBJECT_MIN = 3;
export const BODY_MIN = 20;
