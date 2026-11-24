import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { Suspense } from "react";
import Link from "next/link";
import type { ContactSort } from "@/lib/contacts-page";
import { Copy, Plus } from "lucide-react";
import { listContactLetters, listContactSchoolOptions, listContactsPage } from "@/actions/contacts";
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

  // Start the list query immediately, but do not hold the filter chrome behind it. Letters /
  // plan / schools are cheap and stable across keystrokes; awaiting them alone lets the
  // search pill stay painted while the list streams (search settle was server-bound at 10k).
  const pagePromise = listContactsPage({ ...filters, limit: CONTACTS_PAGE_SIZE });
  const [letters, planOverview, schoolOptions] = await Promise.all([
    listContactLetters(),
    getPlanOverview(),
    listContactSchoolOptions(),
  ]);

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

  return (
    <PeopleListShell
      active="contacts"
      title="Contacts"
      subtitle={
        <Suspense fallback="Your network">
          <ContactsSubtitle pagePromise={pagePromise} filtersActive={filtersActive} />
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
        <ContactQuotaNotice
          used={planOverview.usage.used}
          limit={planOverview.usage.limit}
        />
        <ContactsFilters
          initialQ={params.q || ""}
          initialCompany={params.company || ""}
          initialMinScore={params.minScore || ""}
          initialFollowUp={params.followUp || ""}
          initialSort={sort}
          initialQuiet={quiet === null ? "" : String(quiet)}
          initialTag={params.tag || ""}
          initialSchool={params.school || ""}
          schoolOptions={schoolOptions}
          initialLetter={params.letter || ""}
          importId={params.importId}
        >
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
              activeLetter={params.letter ?? null}
            />
          </Suspense>
        </ContactsFilters>
      </div>
    </PeopleListShell>
  );
}

async function ContactsSubtitle({
  pagePromise,
  filtersActive,
}: {
  pagePromise: Promise<PageResult>;
  filtersActive: boolean;
}) {
  const page = await pagePromise;
  if (page.total === null) return "Your network";
  // `total` counts what the filters matched, not the network. Calling a filtered
  // count "in your network" told someone with 24 contacts that they had 6 — and
  // the more prominent the filters get, the more often that reads as data loss.
  return `${page.total.toLocaleString()} ${page.total === 1 ? "person" : "people"}${
    filtersActive ? " match" : " in your network"
  }`;
}

async function ContactsListBody({
  pagePromise,
  filters,
  letters,
  activeLetter,
}: {
  pagePromise: Promise<PageResult>;
  filters: ContactsListFilters;
  letters: Awaited<ReturnType<typeof listContactLetters>>;
  activeLetter: string | null;
}) {
  const page = await pagePromise;
  return (
    <ContactsList
      initialItems={page.items}
      initialCursor={page.nextCursor}
      total={page.total}
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
