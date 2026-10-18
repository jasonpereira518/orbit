/**
 * Strip bearer credentials out of URLs before anything is sent to Sentry.
 *
 * Several of Orbit's URLs ARE the credential: the calendar feed (`/api/calendar/<token>`),
 * the phone scan handoff (`/scan/<token>`, `/api/scan/<token>/…`), the MCP URL key
 * (`/api/mcp/<key>`), the deep health view (`?token=`), and OAuth callbacks (`?code=`,
 * `?state=`). `sendDefaultPii: false` does not touch URLs, so without this an error on one
 * of those routes stored a working credential in a third-party dashboard — in the request
 * URL, the transaction name and every navigation/fetch breadcrumb.
 *
 * Error text gets the same treatment plus two more: email addresses (an error thrown over a
 * contact or a send names one) and key-shaped strings (`SECRET_PATTERNS`, the set the chat
 * output guard uses). `sendDefaultPii: false` covers neither.
 *
 * And the values of a failed database statement (`redactQueryParams`): a Drizzle error's
 * message ends with the bound parameters, which are often a note or a transcript about a
 * named person. Names and prose cannot be pattern-matched, so they are cut at the source.
 * Extras are scrubbed at any depth, not only top-level strings, and so are the span
 * descriptions of sampled transactions (an outbound fetch span names its URL).
 *
 * Only relative, import-free imports: loaded by the server, edge and browser Sentry configs alike.
 */
import { redactQueryParams } from "./db-error-redact";
import { SECRET_PATTERNS } from "./secret-patterns";

const TOKEN_PATH = /(\/(?:api\/)?(?:calendar|scan|mcp)\/)(?!\[)[^/?#]+/gi;
// `me` is the interest list's personal ticket link.
const TOKEN_QUERY = /([?&](?:token|code|state|key|access_token|me)=)[^&#]*/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function scrubUrl(url: string): string {
  return url.replace(TOKEN_PATH, "$1[redacted]").replace(TOKEN_QUERY, "$1[redacted]");
}

/** For free text — messages, exception values, extras: URLs, then addresses and keys. */
export function scrubText(text: string): string {
  let out = scrubUrl(redactQueryParams(text)).replace(EMAIL, "[email]");
  for (const [, re] of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

type Scrubbable = {
  request?: { url?: string; query_string?: unknown };
  transaction?: string;
  message?: string;
  exception?: { values?: Array<{ value?: string }> };
  extra?: Record<string, unknown>;
  breadcrumbs?: Array<{ data?: Record<string, unknown> | undefined; message?: string }>;
  spans?: Array<{ description?: string }>;
};

function scrubValue(value: unknown): unknown {
  return typeof value === "string" ? scrubUrl(value) : value;
}

/** Strings anywhere inside arrays and plain objects, to a bounded depth. */
function scrubDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubText(value);
  if (depth >= 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v, depth + 1);
  return out;
}

/** For `beforeSend` and `beforeSendTransaction`. Mutates and returns the event. */
export function scrubSentryEvent<T extends Scrubbable>(event: T): T {
  if (event.request) {
    if (event.request.url) event.request.url = scrubUrl(event.request.url);
    // The query string is also sent on its own, as a string or as pairs.
    if (event.request.query_string !== undefined) event.request.query_string = "[redacted]";
  }
  if (event.transaction) event.transaction = scrubUrl(event.transaction);
  if (event.message) event.message = scrubText(event.message);
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = scrubText(ex.value);
  }
  for (const [key, value] of Object.entries(event.extra ?? {})) {
    event.extra![key] = scrubDeep(value);
  }
  for (const span of event.spans ?? []) {
    if (span.description) span.description = scrubText(span.description);
  }
  for (const crumb of event.breadcrumbs ?? []) {
    if (crumb.message) crumb.message = scrubText(crumb.message);
    if (crumb.data) {
      for (const key of ["url", "from", "to"]) {
        if (key in crumb.data) crumb.data[key] = scrubValue(crumb.data[key]);
      }
    }
  }
  return event;
}
