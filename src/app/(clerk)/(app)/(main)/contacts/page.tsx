import { Suspense } from "react";
import Link from "next/link";
import type { ContactSort } from "@/lib/contacts-page";
import { Copy, Plus } from "lucide-react";
import { listContactLetters, listContactsPage } from "@/actions/contacts";
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
import { ContactsList } from "@/components/contacts/contacts-list";
import { PeopleListShell } from "@/components/contacts/people-list-shell";
import { RefreshContactsButton } from "@/components/contacts/refresh-contacts-button";
import { cn } from "@/lib/utils";
import { RenderStamp } from "@/components/layout/render-stamp";


export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    company?: string;
    minScore?: string;
    followUp?: string;
    sort?: string;
    quiet?: string;
    letter?: string;
    tag?: string;
    /** Marks one import's new people in the list (`ContactsList` draws them in yellow). */
    importId?: string;
  }>;
}) {
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
    importId: params.importId,
  };

  const filtersActive = Boolean(
    params.q?.trim() ||
      params.company?.trim() ||
      params.minScore ||
      params.followUp === "due" ||
      params.tag?.trim() ||
      quiet !== null
  );

  // The duplicates button streams in behind the list (`DuplicatesButton` below): its count
  // is a self-join over the whole network, two round trips deep, and it was the slowest
  // thing in this `Promise.all`, so it decided when the list appeared. The quota notice
  // stays here — it renders a line above the list for every free account, and arriving
  // late it would shove the list down after it had painted.
  const [page, letters, planOverview] = await Promise.all([
    // One page, not the whole network. Filtering, searching and ordering all happen in
    // Postgres now, so this costs the same whether the user knows 50 people or 50,000.
    listContactsPage({ ...filters, limit: CONTACTS_PAGE_SIZE }),
    listContactLetters(),
    getPlanOverview(),
  ]);

  return (
    <PeopleListShell
      active="contacts"
      title="Contacts"
      subtitle={
        page.total === null
          ? "Your network"
          : // `total` counts what the filters matched, not the network. Calling a filtered
            // count "in your network" told someone with 24 contacts that they had 6 — and
            // the more prominent the filters get, the more often that reads as data loss.
            `${page.total.toLocaleString()} ${page.total === 1 ? "person" : "people"}${
              filtersActive ? " match" : " in your network"
            }`
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
          initialLetter={params.letter || ""}
          importId={params.importId}
        >
          {/*
            Keyed on the filters so a new query starts from a clean list rather than appending
            onto the previous one's pages. Note this is the *filter* identity, not the contact
            data — the list used to be keyed on the latter, which meant every keystroke tore
            down and rebuilt the whole subtree.
          */}
          <ContactsList
            key={[params.q, params.company, params.minScore, params.followUp, params.tag, String(quiet), sort, params.importId].join("|")}
            initialItems={page.items}
            initialCursor={page.nextCursor}
            total={page.total}
            filters={filters}
            availableLetters={letters}
            activeLetter={params.letter ?? null}
          />
        </ContactsFilters>
      </div>
    </PeopleListShell>
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
