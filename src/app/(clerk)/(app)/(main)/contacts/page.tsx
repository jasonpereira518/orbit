import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { Suspense } from "react";
import Link from "next/link";
import type { ContactSort, ContactsSearchEnrichment } from "@/lib/contacts-page";
import { Copy, Plus } from "lucide-react";
import { listContactLetters, listContactSchoolOptions } from "@/actions/contacts";
import { requireUserId } from "@/lib/auth";
import { ENRICHMENT_EMBED_TIMEOUT_MS, peekRankedContacts } from "@/lib/contact-ranking";
import { enrichLatestContactsSearch, listContactsPage } from "@/lib/contacts-page-query";
import {
  CONTACTS_PAGE_SIZE,
  isContactSort,
  parseQuietDays,
} from "@/lib/contacts-page";
import { getPlanOverview } from "@/actions/settings";
import { countDuplicates } from "@/actions/duplicates";
import { buttonVariants } from "@/components/ui/button";
import { ContactQuotaNotice } from "@/components/contacts/contact-quota-notice";
import { ContactsFilters } from "@/components/contacts/contacts-filters";
import {
  ContactsList,
  type ContactsListFilters,
} from "@/components/contacts/contacts-list";
import { PeopleListShell } from "@/components/contacts/people-list-shell";
import { RefreshContactsButton } from "@/components/contacts/refresh-contacts-button";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion } from "@/components/ui/loading-region";
import { cn } from "@/lib/utils";
import { RenderStamp } from "@/components/layout/render-stamp";

export const metadata = { title: "Contacts" };

type SearchParams = {
  q?: string;
  company?: string;
  minScore?: string;
  followUp?: string;
  sort?: string;
  quiet?: string;
  letter?: string;
  tag?: string;
  /** Alumni of one school, or "@mine" for anyone who went to one of the user's. */
  school?: string;
  /** Marks one import's new people in the list (`ContactsList` draws them in yellow). */
  importId?: string;
};

type PageResult = Awaited<ReturnType<typeof listContactsPage>>;

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const gate = await pageVisibilityGate("page.contacts");
  if (gate) return gate;

  const params = await searchParams;
  // An explicit `sort` always wins; `isContactSort` accepts every value the picker offers
  // plus `relevance`, which the picker deliberately does not (see `contacts-page.ts`).
  // Without one, a search still orders by relevance — main's behaviour, kept.
  const explicitSort = isContactSort(params.sort) ? params.sort : undefined;
  const sort: ContactSort = explicitSort ?? (params.q?.trim() ? "relevance" : "name");
  const quiet = parseQuietDays(params.quiet);
  const searching = Boolean(params.q?.trim());

  const filters = {
    q: params.q,
    company: params.company,
    minScore: params.minScore ? Number(params.minScore) : undefined,
    followUp: params.followUp === "due" ? ("due" as const) : undefined,
    quiet: quiet ?? undefined,
    sort,
    letter: params.letter,
    tag: params.tag,
    school: params.school,
    importId: params.importId,
  };

  const filtersActive = Boolean(
    params.q?.trim() ||
      params.company?.trim() ||
      params.minScore ||
      params.followUp === "due" ||
      params.tag?.trim() ||
      params.school?.trim() ||
      quiet !== null
  );

  // Kick the list query first and never await letters / plan / schools in this function —
  // they used to serialize ahead of every `?q=` navigation under a contended DB. Suspense
  // below lets the list race them.
  // A search paints from its literal matches (`search: "lexical"`: one statement, no ranking in
  // front of it). The rest of the one-shot search — the matches found by meaning and work
  // history, their labels, the exact count, the final order — is computed beside it and
  // streams in the same response, so there is no second request: `ContactsList` folds it in
  // when it lands, and the subtitle swaps "Showing matches" for the exact count. The ranking
  // starts as soon as the page query has been issued (a separate round trip on production's
  // HTTP driver, queued behind it on a single connection) rather than after the first paint.
  const userIdPromise = requireUserId();
  const q3 = (params.q?.trim().length ?? 0) >= 3;
  // If this very search was ranked a moment ago (a refresh, Back, a retyped query) the ranking
  // is in hand: run the one-shot search on it, and the page is final on its first paint — no
  // second step, no reorder. `peeked` is null otherwise, and the two-step path runs.
  const searchPlanPromise = userIdPromise.then((userId) => ({
    userId,
    peeked: q3 ? peekRankedContacts(userId, params.q!.trim(), 80, { embedTimeoutMs: ENRICHMENT_EMBED_TIMEOUT_MS }) : null,
  }));
  const pagePromise = searchPlanPromise.then(({ userId, peeked }) =>
    listContactsPage(
      userId,
      { ...filters, limit: CONTACTS_PAGE_SIZE },
      peeked ? { rank: async () => peeked } : { search: "lexical" }
    )
  );
  // Only when the page is lexical (3+ characters, no ranking in hand).
  const enrichmentPromise: Promise<ContactsSearchEnrichment | null> | null = q3
    ? searchPlanPromise
        .then(({ userId, peeked }) =>
          peeked
            ? null
            : enrichLatestContactsSearch(
                userId,
                { ...filters, limit: CONTACTS_PAGE_SIZE },
                // Only the rows the lexical page lacks cross the wire.
                { have: pagePromise.then((page) => page.items.map((i) => i.id)) }
              )
        )
        // A superseded or failed enrichment is "no enrichment": the lexical list stands.
        .catch(() => null)
    : null;
  const lettersPromise = listContactLetters();
  const planPromise = getPlanOverview();
  const schoolsPromise = listContactSchoolOptions();

  const listKey = [
    params.q,
    params.company,
    params.minScore,
    params.followUp,
    params.tag,
    params.school,
    String(quiet),
    sort,
    params.importId,
  ].join("|");

  const filterProps = {
    initialQ: params.q || "",
    initialCompany: params.company || "",
    initialMinScore: params.minScore || "",
    initialFollowUp: params.followUp || "",
    initialSort: sort,
    initialQuiet: quiet === null ? "" : String(quiet),
    initialTag: params.tag || "",
    initialSchool: params.school || "",
    initialLetter: params.letter || "",
    importId: params.importId,
  };

  return (
    <PeopleListShell
      active="contacts"
      title="Contacts"
      subtitle={
        <Suspense fallback={searching ? "Showing matches" : "Your network"}>
          <ContactsSubtitle
            pagePromise={pagePromise}
            filtersActive={filtersActive}
            searching={searching}
            enrichmentPromise={enrichmentPromise}
          />
        </Suspense>
      }
      actions={
        <>
          {/* No fallback: the button only exists when there are duplicates, so it arriving
              a beat late is indistinguishable from it being there. */}
          <Suspense fallback={null}>
            <DuplicatesButton />
          </Suspense>
          <RefreshContactsButton />
          <Link
            href="/contacts/new"
            className={cn(
              buttonVariants(),
              "bg-primary text-primary-foreground hover:bg-primary/90"
            )}
          >
            <Plus className="mr-1 h-4 w-4" />
            Add contact
          </Link>
        </>
      }
    >
      <RenderStamp />
      <div className="space-y-6">
        <Suspense fallback={null}>
          <QuotaNotice planPromise={planPromise} />
        </Suspense>
        <Suspense
          fallback={
            <ContactsFilters {...filterProps} schoolOptions={{ mine: [], network: [] }}>
              <ContactsListRowsSkeleton />
            </ContactsFilters>
          }
        >
          <FiltersWithChrome
            filterProps={filterProps}
            filters={filters}
            schoolsPromise={schoolsPromise}
            lettersPromise={lettersPromise}
            pagePromise={pagePromise}
            enrichmentPromise={enrichmentPromise}
            listKey={listKey}
            activeLetter={params.letter ?? null}
          />
        </Suspense>
      </div>
    </PeopleListShell>
  );
}

async function QuotaNotice({
  planPromise,
}: {
  planPromise: ReturnType<typeof getPlanOverview>;
}) {
  const planOverview = await planPromise;
  return (
    <ContactQuotaNotice
      used={planOverview.usage.used}
      limit={planOverview.usage.limit}
    />
  );
}

async function FiltersWithChrome({
  filterProps,
  filters,
  schoolsPromise,
  lettersPromise,
  pagePromise,
  enrichmentPromise,
  listKey,
  activeLetter,
}: {
  filterProps: {
    initialQ: string;
    initialCompany: string;
    initialMinScore: string;
    initialFollowUp: string;
    initialSort: ContactSort;
    initialQuiet: string;
    initialTag: string;
    initialSchool: string;
    initialLetter: string;
    importId?: string;
  };
  filters: ContactsListFilters;
  schoolsPromise: ReturnType<typeof listContactSchoolOptions>;
  lettersPromise: ReturnType<typeof listContactLetters>;
  pagePromise: Promise<PageResult>;
  enrichmentPromise: Promise<ContactsSearchEnrichment | null> | null;
  listKey: string;
  activeLetter: string | null;
}) {
  // Schools (and letters for the A–Z rail) are independent of the list query; awaiting them
  // here only gates the filter chrome, while `pagePromise` keeps running for the inner Suspense.
  const [schoolOptions, letters] = await Promise.all([schoolsPromise, lettersPromise]);
  return (
    <ContactsFilters {...filterProps} schoolOptions={schoolOptions}>
      {/*
        Keyed on the filters so a new query starts from a clean list rather than appending
        onto the previous one's pages. Note this is the *filter* identity, not the contact
        data — the list used to be keyed on the latter, which meant every keystroke tore
        down and rebuilt the whole subtree.
      */}
      <Suspense key={listKey} fallback={<ContactsListRowsSkeleton />}>
        <ContactsListBody
          pagePromise={pagePromise}
          filters={filters}
          letters={letters}
          activeLetter={activeLetter}
          enrichmentPromise={enrichmentPromise}
        />
      </Suspense>
    </ContactsFilters>
  );
}

async function ContactsSubtitle({
  pagePromise,
  filtersActive,
  searching,
  enrichmentPromise,
}: {
  pagePromise: Promise<PageResult>;
  filtersActive: boolean;
  searching: boolean;
  enrichmentPromise: Promise<ContactsSearchEnrichment | null> | null;
}) {
  const page = await pagePromise;
  // A lexical first page has no exact count yet: it arrives with the enrichment.
  if (page.searchPending && enrichmentPromise) {
    return (
      <Suspense fallback="Showing matches">
        <EnrichedSubtitle enrichmentPromise={enrichmentPromise} />
      </Suspense>
    );
  }
  // A cursor page has no total, and neither does a search the one-shot way: don't claim
  // "Your network" while filtering.
  if (page.total === null) {
    return searching || filtersActive ? "Showing matches" : "Your network";
  }
  // `total` counts what the filters matched, not the network. Calling a filtered
  // count "in your network" told someone with 24 contacts that they had 6 — and
  // the more prominent the filters get, the more often that reads as data loss.
  return `${page.total.toLocaleString()} ${page.total === 1 ? "person" : "people"}${
    filtersActive ? " match" : " in your network"
  }`;
}

/** "N people match", once the exact count is known; "Showing matches" if it never is. */
async function EnrichedSubtitle({
  enrichmentPromise,
}: {
  enrichmentPromise: Promise<ContactsSearchEnrichment | null>;
}) {
  const enrichment = await enrichmentPromise;
  if (!enrichment) return "Showing matches";
  const { total } = enrichment;
  return `${total.toLocaleString()} ${total === 1 ? "person" : "people"} match`;
}

async function ContactsListBody({
  pagePromise,
  filters,
  letters,
  activeLetter,
  enrichmentPromise,
}: {
  pagePromise: Promise<PageResult>;
  filters: ContactsListFilters;
  letters: Awaited<ReturnType<typeof listContactLetters>>;
  activeLetter: string | null;
  enrichmentPromise: Promise<ContactsSearchEnrichment | null> | null;
}) {
  const page = await pagePromise;
  return (
    <ContactsList
      initialItems={page.items}
      initialCursor={page.nextCursor}
      total={page.total}
      enrichment={page.searchPending ? enrichmentPromise : null}
      filters={filters}
      availableLetters={letters}
      activeLetter={activeLetter}
    />
  );
}

/** List rows only — filters stay mounted above while search RSC streams. */
function ContactsListRowsSkeleton() {
  return (
    <LoadingRegion label="Loading contacts" className="overflow-hidden rounded-2xl border border-border/70">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center justify-between gap-4 border-b border-border/60 px-5 py-4 last:border-0"
        >
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-48" />
          </div>
          <Skeleton className="h-6 w-16 rounded-full" />
        </div>
      ))}
    </LoadingRegion>
  );
}

/** Cheap and capped; decides whether the review entry point appears at all. */
async function DuplicatesButton() {
  const duplicateCount = await countDuplicates().catch(() => 0);
  if (duplicateCount <= 0) return null;
  return (
    <Link href="/contacts/duplicates" className={cn(buttonVariants({ variant: "outline" }))}>
      <Copy className="mr-1 h-4 w-4" aria-hidden />
      {duplicateCount >= 99
        ? "99+ duplicates"
        : `${duplicateCount} duplicate${duplicateCount === 1 ? "" : "s"}`}
    </Link>
  );
}
