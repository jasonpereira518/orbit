/**
 * Clerk's error codes, in Orbit's voice.
 *
 * Clerk throws `ClerkAPIResponseError`, whose `errors[]` carry a stable `code` and a
 * message written by Clerk. The messages are fine English and the wrong voice, so the
 * account screens show ours for the codes people actually hit and fall back to
 * `TOAST_COPY.saveFailed` for everything else.
 *
 * Deliberately free of any Clerk import: this is shape-matching, so it stays testable
 * from a plain tsx script with no browser and no provider.
 */
export const CLERK_ERROR_COPY: Readonly<Record<string, string>> = {
  form_password_pwned: "That password has shown up in a breach — pick another",
  form_code_incorrect: "That code didn't match — check and try again",
  form_identifier_exists: "That email is already on your account",
  form_password_incorrect: "That password wasn't right — try again",
  form_password_validation_failed: "That password is too weak — make it longer",
  form_param_format_invalid: "That doesn't look like an email address",
  form_identifier_not_allowed: "That address can't be used here",
  session_exists: "You're already signed in on this device",
};

/** Narrow, without importing Clerk, to `{ errors: [{ code }] }`. */
function codesOf(err: unknown): string[] {
  if (!err || typeof err !== "object") return [];
  const errors = (err as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .map((e) => (e && typeof e === "object" ? (e as { code?: unknown }).code : null))
    .filter((c): c is string => typeof c === "string");
}

/**
 * Orbit copy for a Clerk failure, or `fallback` when the code is one we have not written
 * for. Callers pass `TOAST_COPY.saveFailed` (or a closer line) as the fallback, so no raw
 * provider text ever reaches a toast.
 */
export function clerkErrorMessage(err: unknown, fallback: string): string {
  for (const code of codesOf(err)) {
    const copy = CLERK_ERROR_COPY[code];
    if (copy) return copy;
  }
  return fallback;
}
