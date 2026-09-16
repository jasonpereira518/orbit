import Link from "next/link";
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
  }>;
}) {
  const params = await searchParams;
  const sort = isContactSort(params.sort) ? params.sort : "name";
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
  };

  const filtersActive = Boolean(
    params.q?.trim() ||
      params.company?.trim() ||
      params.minScore ||
      params.followUp === "due" ||
      params.tag?.trim() ||
      quiet !== null
  );

  const [page, letters, planOverview, duplicateCount] = await Promise.all([
    // One page, not the whole network. Filtering, searching and ordering all happen in
    // Postgres now, so this costs the same whether the user knows 50 people or 50,000.
    listContactsPage({ ...filters, limit: CONTACTS_PAGE_SIZE }),
    listContactLetters(),
    getPlanOverview(),
    // Cheap and capped; decides whether the review entry point appears at all.
    countDuplicates(),
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
          {duplicateCount > 0 ? (
            <Link
              href="/contacts/duplicates"
              className={cn(buttonVariants({ variant: "outline" }))}
            >
              <Copy className="mr-1 h-4 w-4" aria-hidden />
              {duplicateCount >= 99 ? "99+ duplicates" : `${duplicateCount} duplicate${duplicateCount === 1 ? "" : "s"}`}
            </Link>
          ) : null}
          <RefreshContactsButton />
          <Link
            href="/capture"
            className={cn(buttonVariants({ variant: "outline" }))}
          >
            AI capture
          </Link>
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
        >
          {/*
            Keyed on the filters so a new query starts from a clean list rather than appending
            onto the previous one's pages. Note this is the *filter* identity, not the contact
            data — the list used to be keyed on the latter, which meant every keystroke tore
            down and rebuilt the whole subtree.
          */}
          <ContactsList
            key={[params.q, params.company, params.minScore, params.followUp, params.tag, String(quiet), sort].join("|")}
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
