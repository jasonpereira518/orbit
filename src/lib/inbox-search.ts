/**
 * Deep links that open the user's own webmail with a search already run.
 *
 * Built for one job today: getting someone back to LinkedIn's "your data archive is
 * ready" email a day after they requested the export. That mail is the single point the
 * whole deferred-LinkedIn flow hinges on, and "go find an email from about a day ago"
 * is exactly the instruction a non-technical user gives up on.
 *
 * Pure — no `next/*`, no `@/db` — because a client component, a server action, and a
 * plain tsx script all need to build the same URL.
 */

/**
 * LinkedIn sends the archive from a no-reply address on `linkedin.com`
 * (`messages-noreply@linkedin.com` at the time of writing) with "data archive" in the
 * subject, and splits a large export into parts that each arrive as their own mail. The
 * query therefore matches the sending domain plus the word `archive` rather than one
 * exact sender or subject line, so it keeps working when either changes and still finds
 * every part.
 */
export const LINKEDIN_ARCHIVE_SEARCH = "from:linkedin.com archive";

export type InboxProvider = "gmail" | "outlook";

/**
 * Only domains Microsoft actually owns route to Outlook. Everything else — gmail.com, a
 * university or company domain, an address we have never seen — gets Gmail: it is the
 * common case for the students Orbit is built for, and the provider Orbit already
 * integrates with.
 *
 * A custom domain can sit behind either provider and nothing in the address says which,
 * so the button names the provider it is about to open ("Search Gmail") instead of
 * claiming to know where the mail actually lives. Being visibly wrong is recoverable;
 * silently opening the wrong inbox is not.
 */
const MICROSOFT_DOMAINS = new Set([
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "passport.com",
  "windowslive.com",
]);

export function inboxProviderFor(email?: string | null): InboxProvider {
  const domain = email?.trim().toLowerCase().split("@")[1];
  return domain && MICROSOFT_DOMAINS.has(domain) ? "outlook" : "gmail";
}

export function inboxSearchUrl(query: string, email?: string | null): string {
  if (inboxProviderFor(email) === "outlook") {
    // Outlook's documented deep link is `/mail/deeplink/search?query=` on
    // outlook.office.com (work and school accounts); every domain that reaches this
    // branch is a consumer account, which lives on outlook.live.com instead, so the
    // host differs while the path matches. If the path is ever rejected there, OWA
    // falls back to the inbox — the wrong view, not a dead link.
    return `https://outlook.live.com/mail/0/deeplink/search?query=${encodeURIComponent(query)}`;
  }
  // Gmail carries the search in the fragment, which is what the address bar shows after
  // any search. `/u/0` is the first signed-in account: a multi-account user may land in
  // the wrong one, and switching accounts keeps the search.
  return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`;
}

export function inboxSearchLabel(email?: string | null): string {
  return inboxProviderFor(email) === "outlook" ? "Search Outlook" : "Search Gmail";
}

/** The LinkedIn-archive search, resolved for one user — url, button label, raw terms. */
export function linkedInArchiveSearch(email?: string | null): {
  url: string;
  label: string;
  query: string;
} {
  return {
    url: inboxSearchUrl(LINKEDIN_ARCHIVE_SEARCH, email),
    label: inboxSearchLabel(email),
    query: LINKEDIN_ARCHIVE_SEARCH,
  };
}
