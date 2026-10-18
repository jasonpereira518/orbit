/**
 * Keep the VALUES of a failed database statement out of every place an error is written.
 *
 * Drizzle wraps each failed statement in `DrizzleQueryError("Failed query: <sql>\nparams:
 * <values>")`, and the values are whatever the statement was writing: a note about a named
 * person, a transcript passage, a phone number. That message went verbatim to Vercel's logs,
 * to Sentry (whose scrubber only removed email addresses), into `error_events.message`, and
 * — for an uncaught error with no Sentry DSN — into a Slack message.
 * `privacy/probe-log-scrub.ts` showed a name, a phone number and a sensitive note surviving
 * the scrubber intact.
 *
 * The SQL text itself is kept: it names the table and columns, which is what debugging
 * needs. Everything after `params:` goes. The driver's own error (the `cause`) is rebuilt
 * from its message and code alone, because Postgres puts the offending values in `detail`
 * ("Key (email)=(…) already exists") and the driver copies them onto the error object.
 *
 * Import-free on purpose: the server, edge and browser Sentry configs all load
 * `sentry-scrub.ts`, which uses this.
 */

const PARAMS_TAIL = /(Failed query: [\s\S]*?)\nparams: [\s\S]*$/;

/** The text with any `params:` tail of a failed-query message replaced. */
export function redactQueryParams(text: string): string {
  return text.replace(PARAMS_TAIL, "$1\nparams: [redacted]");
}

/** Message and code only: Postgres error objects carry the offending row in `detail`. */
function bareCause(cause: unknown): unknown {
  if (!(cause instanceof Error)) return cause;
  const copy = new Error(redactQueryParams(cause.message));
  copy.name = cause.name;
  const code = (cause as { code?: unknown }).code;
  if (typeof code === "string") (copy as Error & { code?: string }).code = code;
  return copy;
}

/**
 * The error to hand to a logger or Sentry in place of `err`. A failed-query error comes back
 * as a copy with its values removed (message, stack and cause); anything else is returned
 * untouched. Never mutates `err`: the caller may still be reading its message.
 */
export function redactDbError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const message = redactQueryParams(err.message);
  if (message === err.message) return err;
  const copy = new Error(message);
  copy.name = err.name;
  copy.stack = err.stack ? err.stack.replace(err.message, message) : undefined;
  if (err.cause !== undefined) copy.cause = bareCause(err.cause);
  return copy;
}
