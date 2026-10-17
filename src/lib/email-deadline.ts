/**
 * A deadline for a Resend call. The SDK is `fetch` with no signal, so a hung API held its
 * function until the platform killed it (up to `maxDuration`, minutes), and a Resend brownout
 * therefore stalled everything that sends mail. The call is abandoned, not cancelled: a send
 * that did go through after the deadline is exactly the case a Resend idempotency key or the
 * caller's own claim already covers.
 */
export const EMAIL_SEND_DEADLINE_MS = 15_000;

export class EmailDeadlineError extends Error {
  constructor() {
    super("Resend did not answer in time");
    this.name = "EmailDeadlineError";
  }
}

export function withEmailDeadline<T>(call: Promise<T>, ms = EMAIL_SEND_DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new EmailDeadlineError()), ms);
  });
  // The abandoned call may still reject later; it must not become an unhandled rejection.
  call.catch(() => {});
  return Promise.race([call, deadline]).finally(() => clearTimeout(timer));
}
