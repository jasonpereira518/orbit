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
 * No imports: loaded by the server, edge and browser Sentry configs alike.
 */

const TOKEN_PATH = /(\/(?:api\/)?(?:calendar|scan|mcp)\/)(?!\[)[^/?#]+/gi;
const TOKEN_QUERY = /([?&](?:token|code|state|key|access_token)=)[^&#]*/gi;

export function scrubUrl(url: string): string {
  return url.replace(TOKEN_PATH, "$1[redacted]").replace(TOKEN_QUERY, "$1[redacted]");
}

type Scrubbable = {
  request?: { url?: string; query_string?: unknown };
  transaction?: string;
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
  for (const crumb of event.breadcrumbs ?? []) {
    if (crumb.message) crumb.message = scrubUrl(crumb.message);
    if (crumb.data) {
      for (const key of ["url", "from", "to"]) {
        if (key in crumb.data) crumb.data[key] = scrubValue(crumb.data[key]);
      }
    }
  }
  return event;
}
