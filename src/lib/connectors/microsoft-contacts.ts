/**
 * Outlook / Microsoft 365 contacts, as a source of `PersonRecord`s.
 *
 * Fetch and map only, mirroring `google-contacts.ts`: no database statement, so it is testable
 * against recorded fixtures, and the write path stays in one place (`ingest/people.ts`). Like
 * the calendar connector beside it, it is a *scope extension* of the Outlook connection Orbit
 * already holds for the one-shot import — no second OAuth flow, table or callback.
 *
 * ## Why this is not a Graph `delta` query
 *
 * Google's connector uses a `syncToken`. Graph's equivalent, `contactFolders/{id}/contacts/delta`,
 * is per FOLDER: a book with contacts filed in several folders needs one delta per folder and a
 * cursor for each, and the docs do not promise that a well-known name can stand in for the
 * default folder's id. `GET /me/contacts` spans every folder at once and accepts a
 * `lastModifiedDateTime` filter, so the incremental position is a single timestamp.
 *
 * That is a weaker primitive than a delta token, and the difference is worth stating:
 *
 * - **Deletions are invisible.** Fine — Orbit never deletes a contact because an address book
 *   did (the person may be here for other reasons and `contacts` has no soft delete). The
 *   Google connector counts and skips its tombstones for the same reason.
 * - **The watermark is a clock, not a token.** It is the moment the read STARTED, minus an
 *   overlap, so a contact edited while a long first read was paging is still picked up by the
 *   next run. Re-reading a few people twice is harmless: `ingestPeople` matches and fills
 *   blanks, it does not duplicate.
 * - **The filter is the one thing not verified against a live account.** If Graph ever
 *   rejects it (400), `ContactsFilterRejectedError` tells the caller to drop the watermark
 *   and read the whole book — slower every run, never wrong.
 *
 * ## The failure modes worth knowing
 *
 * 1. **Adopting the watermark before the read finishes.** It is set only when a run has no
 *    more pages, exactly like the Google connector's `nextSyncToken`. Setting it early would
 *    skip every contact on the pages not yet read, silently, forever.
 * 2. **Losing the start time across resumed runs.** A first read of a large book spans
 *    several scheduler passes; the start time is carried in the cursor (`readStartedAt`) so
 *    the watermark reflects when the read began, not when its last page landed.
 */
import type { PersonRecord } from "@/lib/ingest/people";

const CONTACTS_API = "https://graph.microsoft.com/v1.0/me/contacts";

/** The same fields the one-shot import reads, so a synced person matches an imported one. */
const CONTACT_FIELDS =
  "displayName,givenName,surname,companyName,jobTitle,emailAddresses,businessPhones,mobilePhone";

const PAGE_SIZE = 200;

/**
 * How far behind the read's start the next watermark sits. Covers clock skew between Orbit
 * and Graph and a contact saved in the seconds around the read; costs a handful of re-reads.
 */
export const WATERMARK_OVERLAP_MS = 5 * 60 * 1000;

/** Raised when Graph refuses the `lastModifiedDateTime` filter. Callers drop the watermark. */
export class ContactsFilterRejectedError extends Error {
  constructor() {
    super("Microsoft contacts rejected the lastModifiedDateTime filter (400) — full read required");
    this.name = "ContactsFilterRejectedError";
  }
}

type GraphContact = {
  id?: string;
  displayName?: string;
  givenName?: string;
  surname?: string;
  companyName?: string;
  jobTitle?: string;
  emailAddresses?: Array<{ address?: string }>;
  businessPhones?: string[];
  mobilePhone?: string;
};

type GraphContactsPage = {
  value?: GraphContact[];
  "@odata.nextLink"?: string;
};

/**
 * Where a Microsoft contacts sync is up to.
 *
 * `syncToken` is the ISO watermark for the next incremental read; `pageToken` is the full
 * `@odata.nextLink` URL of the run in progress; `readStartedAt` is when that run began.
 * Field names match the Google cursor so both live under `ProviderSyncCursor.contacts`.
 */
export type MicrosoftContactsCursor = {
  syncToken?: string | null;
  pageToken?: string | null;
  readStartedAt?: string | null;
  /** People the plan cap held back — carried through by the scheduler, never read here. */
  blockedByPlan?: number | null;
};

export type MicrosoftContactsFetchResult = {
  people: PersonRecord[];
  /** Present only while the run has more pages. */
  nextPageToken: string | null;
  /** People with no usable name, counted and skipped. */
  nameless: number;
};

export type FetchMicrosoftContactsPageOptions = {
  accessToken: string;
  cursor: MicrosoftContactsCursor | null;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

/** Map one Graph contact to a `PersonRecord`, or null when there is no name to call them by. */
export function toPersonRecord(contact: GraphContact): PersonRecord | null {
  const fullName =
    contact.displayName?.trim() ||
    [contact.givenName, contact.surname].filter(Boolean).join(" ").trim();
  if (!fullName) return null;
  return {
    fullName,
    email: contact.emailAddresses?.find((e) => e.address?.trim())?.address?.trim() || null,
    phone: contact.businessPhones?.find((p) => p?.trim())?.trim() || contact.mobilePhone?.trim() || null,
    company: contact.companyName?.trim() || null,
    title: contact.jobTitle?.trim() || null,
  };
}

function firstPageUrl(cursor: MicrosoftContactsCursor | null): string {
  // Built by hand, like `fetchOutlookContacts`: `URLSearchParams` would turn `$top` into
  // `%24top` and a filter's spaces into `+`, which OData reads literally.
  const base = `${CONTACTS_API}?$top=${PAGE_SIZE}&$select=${CONTACT_FIELDS}`;
  // Only an incremental read carries a filter.
  if (!cursor?.syncToken) return base;
  return `${base}&$filter=${encodeURIComponent(`lastModifiedDateTime ge ${cursor.syncToken}`)}`;
}

/** Read one page of the user's contacts (or the changes since the watermark). */
export async function fetchContactsPage(
  opts: FetchMicrosoftContactsPageOptions
): Promise<MicrosoftContactsFetchResult> {
  const { accessToken, cursor } = opts;
  const doFetch = opts.fetchImpl ?? fetch;

  // Mid-run: the `@odata.nextLink` is a complete URL that already carries the filter it started
  // with, so it is followed as-is rather than rebuilt.
  const url = cursor?.pageToken || firstPageUrl(cursor);

  const res = await doFetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    // A page of contacts, well inside the scheduler's 60-second per-connection budget.
    signal: AbortSignal.timeout(20_000),
  });

  if (res.status === 400 && cursor?.syncToken) throw new ContactsFilterRejectedError();
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Microsoft Contacts ${res.status}: ${body.slice(0, 200)}`);
  }

  const page = (await res.json()) as GraphContactsPage;
  const people: PersonRecord[] = [];
  let nameless = 0;
  for (const contact of page.value || []) {
    const record = toPersonRecord(contact);
    if (record) people.push(record);
    else nameless++;
  }

  return { people, nextPageToken: page["@odata.nextLink"] ?? null, nameless };
}

/**
 * Fold a page into the cursor for the next request.
 *
 * Mid-run it keeps the read's start time and the next page; on the last page it turns that
 * start time into the watermark and clears the run state. `now` stamps the start of a read
 * that has none yet.
 */
export function advanceContactsCursor(
  cursor: MicrosoftContactsCursor | null,
  page: MicrosoftContactsFetchResult,
  now: Date
): MicrosoftContactsCursor {
  const startedAt = cursor?.readStartedAt ?? now.toISOString();
  if (page.nextPageToken) {
    return {
      syncToken: cursor?.syncToken ?? null,
      pageToken: page.nextPageToken,
      readStartedAt: startedAt,
    };
  }
  return {
    syncToken: new Date(Date.parse(startedAt) - WATERMARK_OVERLAP_MS).toISOString(),
    pageToken: null,
    readStartedAt: null,
  };
}
