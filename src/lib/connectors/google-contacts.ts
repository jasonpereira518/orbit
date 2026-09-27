/**
 * Google Contacts, as a source of `PersonRecord`s.
 *
 * Fetch and map only — this module issues no database statement of any kind, which is what
 * lets it be tested against recorded fixtures with no database at all and keeps the write
 * path in exactly one place (`src/lib/ingest/people.ts`).
 *
 * It is a *scope extension*, not a new provider, for the same reason `google-calendar.ts`
 * says so: the token comes from the Google connection Orbit already holds, so there is no
 * second OAuth flow, no second table and no second callback route. `hasContactsScope` is the
 * capability probe.
 *
 * ## Why this exists when `fetchGooglePeopleContacts` already does
 *
 * That one re-reads the entire address book on every call, because it serves a one-shot
 * import a person clicks. A continuous sync cannot do that twice an hour: it is the whole
 * book fetched to discover the two people who changed. This module asks for a `syncToken`
 * instead, and every later run is a delta.
 *
 * ## The three ways an incremental People sync goes wrong
 *
 * 1. **Taking `nextSyncToken` from the wrong page.** Google returns it only on the *final*
 *    page of a run. Persisting it earlier means every contact on the pages not yet read is
 *    skipped forever, silently, because the next run starts from a token claiming you are
 *    up to date. Same failure as the calendar connector's, and the same rule: only a page
 *    with no `nextPageToken` may contribute one.
 * 2. **Sending `syncToken` with parameters the first fetch used.** The People API rejects a
 *    `syncToken` combined with `sortOrder` (400 FAILED_PRECONDITION). Anything that shapes
 *    the first full read belongs to that read alone.
 * 3. **Treating a 410 as a failure.** An expired `syncToken` is a normal lifecycle event —
 *    Google expires them on its own schedule, and the docs say roughly seven days. It means
 *    "start over", not "this connection is broken"; counting it as a failure would walk a
 *    healthy connection up the backoff ladder and eventually disarm it.
 *
 * ## Deletions are counted, not acted on
 *
 * In sync mode Google returns deleted people as tombstones (`metadata.deleted`). Orbit does
 * not delete a contact because an address book did: the person may be in Orbit for reasons
 * that have nothing to do with Google, and `contacts` has no soft delete to make it
 * reversible. They are counted so the behaviour is visible, and otherwise skipped — the same
 * decision, for the same reason, that the calendar connector makes for cancelled events.
 */
import { googleFetchWithRetry } from "@/lib/google-fetch";
import type { PersonRecord } from "@/lib/ingest/people";

const PEOPLE_API = "https://people.googleapis.com/v1/people/me/connections";

/**
 * Fields asked for on every page.
 *
 * Deliberately the same set the one-shot import already requests, minus `photos`: this path
 * feeds `ingestPeople`, which has nowhere to put a photo URL, and asking for a field nothing
 * reads is a larger response on every page of every sync.
 */
const PERSON_FIELDS = "names,emailAddresses,organizations,phoneNumbers,metadata";

/** The API's maximum for this endpoint, so a quiet address book finishes in one request. */
const PAGE_SIZE = 1000;

/** Raised for an expired `syncToken`. Callers must reset the cursor, NOT count a failure. */
export class PeopleSyncTokenExpiredError extends Error {
  constructor() {
    super("Google People syncToken expired (410) — full resync required");
    this.name = "PeopleSyncTokenExpiredError";
  }
}

type PeopleApiName = { displayName?: string; givenName?: string; familyName?: string };
type PeopleApiEmail = { value?: string; metadata?: { primary?: boolean } };
type PeopleApiOrg = { name?: string; title?: string };
type PeopleApiPhone = { value?: string; metadata?: { primary?: boolean } };

type PeopleApiPerson = {
  resourceName?: string;
  names?: PeopleApiName[];
  emailAddresses?: PeopleApiEmail[];
  organizations?: PeopleApiOrg[];
  phoneNumbers?: PeopleApiPhone[];
  metadata?: { deleted?: boolean };
};

type PeopleApiPage = {
  connections?: PeopleApiPerson[];
  nextPageToken?: string;
  nextSyncToken?: string;
};

/**
 * Where a contacts sync is up to.
 *
 * `syncToken` is the delta position; `pageToken` is the position *within* one run, and is
 * what makes a first sync of a large address book resume rather than restart when it runs
 * out of time budget.
 */
export type ContactsSyncCursor = {
  syncToken?: string | null;
  pageToken?: string | null;
};

export type ContactsFetchResult = {
  people: PersonRecord[];
  /** Present only on the last page of a run — see failure mode 1. */
  nextSyncToken: string | null;
  nextPageToken: string | null;
  /** Deleted people, counted and skipped. */
  tombstones: number;
  /** People with no usable name, counted and skipped — a contact needs something to call it. */
  nameless: number;
};

export type FetchContactsPageOptions = {
  accessToken: string;
  cursor: ContactsSyncCursor | null;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

/** The primary entry of a list, or the first one, or null. */
function preferred<T extends { metadata?: { primary?: boolean } }>(items: T[] | undefined): T | null {
  if (!items || items.length === 0) return null;
  return items.find((item) => item.metadata?.primary) ?? items[0];
}

/**
 * Map one API person to a `PersonRecord`, or null when there is no name to call them by.
 *
 * `ingestPeople` matches on name, email, LinkedIn and handle; Google gives us the first two.
 * A record with an email but no name is dropped rather than invented for, because the
 * duplicate index would key it on an empty name and fold unrelated people together.
 */
export function toPersonRecord(person: PeopleApiPerson): PersonRecord | null {
  const name = preferred(person.names as ({ metadata?: { primary?: boolean } } & PeopleApiName)[]);
  const fullName =
    name?.displayName?.trim() ||
    [name?.givenName, name?.familyName].filter(Boolean).join(" ").trim();
  if (!fullName) return null;

  const org = person.organizations?.[0];
  return {
    fullName,
    email: preferred(person.emailAddresses)?.value?.trim() || null,
    phone: preferred(person.phoneNumbers)?.value?.trim() || null,
    company: org?.name?.trim() || null,
    title: org?.title?.trim() || null,
  };
}

/**
 * Read one page of the user's connections.
 *
 * A `syncToken` and a `pageToken` are both carried on the cursor and both may be sent: the
 * first says which delta to read, the second where in that delta this run stopped.
 */
export async function fetchContactsPage(
  opts: FetchContactsPageOptions
): Promise<ContactsFetchResult> {
  const { accessToken, cursor } = opts;

  const params = new URLSearchParams({
    personFields: PERSON_FIELDS,
    pageSize: String(PAGE_SIZE),
  });

  if (cursor?.syncToken) {
    params.set("syncToken", cursor.syncToken);
  } else {
    // Only a full read may ask for one; see failure mode 2.
    params.set("requestSyncToken", "true");
  }
  if (cursor?.pageToken) params.set("pageToken", cursor.pageToken);

  const res = await googleFetchWithRetry(`${PEOPLE_API}?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    // Well inside the scheduler's 60-second per-connection budget.
    timeoutMs: 20_000,
    fetchImpl: opts.fetchImpl,
  });

  if (res.status === 410) throw new PeopleSyncTokenExpiredError();
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Google People ${res.status}: ${body.slice(0, 200)}`);
  }

  const page = (await res.json()) as PeopleApiPage;
  const connections = page.connections || [];

  const people: PersonRecord[] = [];
  let tombstones = 0;
  let nameless = 0;

  for (const person of connections) {
    if (person.metadata?.deleted) {
      tombstones++;
      continue;
    }
    const record = toPersonRecord(person);
    if (record) people.push(record);
    else nameless++;
  }

  return {
    people,
    nextSyncToken: page.nextSyncToken ?? null,
    nextPageToken: page.nextPageToken ?? null,
    tombstones,
    nameless,
  };
}

/**
 * Fold a page's tokens into the cursor for the next request.
 *
 * `nextSyncToken` is taken only when the run has no more pages — failure mode 1 — and taking
 * it clears `pageToken`, because the next run starts a fresh delta rather than resuming this
 * one.
 */
export function advanceContactsCursor(
  cursor: ContactsSyncCursor | null,
  page: ContactsFetchResult
): ContactsSyncCursor {
  if (!page.nextPageToken) {
    return { syncToken: page.nextSyncToken ?? cursor?.syncToken ?? null, pageToken: null };
  }
  return { syncToken: cursor?.syncToken ?? null, pageToken: page.nextPageToken };
}
