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
 * Only relative, import-free imports: loaded by the server, edge and browser Sentry configs alike.
 */
import { SECRET_PATTERNS } from "./secret-patterns";

const TOKEN_PATH = /(\/(?:api\/)?(?:calendar|scan|mcp)\/)(?!\[)[^/?#]+/gi;
// `me` is the interest list's personal ticket link. The rest are the OAuth and API
// parameters that show up on the callbacks and on pasted curl commands.
const TOKEN_QUERY =
  /([?&](?:token|code|state|key|access_token|refresh_token|id_token|api_key|secret|password|client_secret|me)=)[^&#]*/gi;
// `password=hunter2` in a message or an extra, not a URL parameter. Bounded by a word
// boundary and requiring a value of some length so prose ("secret: none") stays readable.
const KEY_VALUE =
  /\b(password|passwd|secret|client_secret|api_?key|access_?token|refresh_?token|authorization)(\s*[:=]\s*)("[^"]{4,}"|'[^']{4,}'|[^\s,;]{4,})/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function scrubUrl(url: string): string {
  return url.replace(TOKEN_PATH, "$1[redacted]").replace(TOKEN_QUERY, "$1[redacted]");
}

/** For free text — messages, exception values, extras: URLs, then addresses, keys, k/v. */
export function scrubText(text: string): string {
  let out = scrubUrl(text).replace(EMAIL, "[email]");
  out = out.replace(KEY_VALUE, "$1$2[redacted]");
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
};

function scrubValue(value: unknown): unknown {
  return typeof value === "string" ? scrubUrl(value) : value;
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
    if (typeof value === "string") event.extra![key] = scrubText(value);
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
