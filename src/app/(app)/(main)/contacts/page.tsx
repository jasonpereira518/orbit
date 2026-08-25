import Link from "next/link";
import { Plus } from "lucide-react";
import { listContactLetters, listContactsPage } from "@/actions/contacts";
import { CONTACTS_PAGE_SIZE, type ContactSort } from "@/lib/contacts-page";
import { getPlanOverview } from "@/actions/settings";
import { buttonVariants } from "@/components/ui/button";
import { ContactQuotaNotice } from "@/components/contacts/contact-quota-notice";
import { ContactsFilters } from "@/components/contacts/contacts-filters";
import { ContactsList } from "@/components/contacts/contacts-list";
import { PeopleListShell } from "@/components/contacts/people-list-shell";
import { RefreshContactsButton } from "@/components/contacts/refresh-contacts-button";
import { cn } from "@/lib/utils";

const SORTS: ContactSort[] = ["name", "closeness", "recent"];

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    company?: string;
    minScore?: string;
    followUp?: string;
    sort?: string;
    letter?: string;
  }>;
}) {
  const params = await searchParams;
  const sort = SORTS.includes(params.sort as ContactSort)
    ? (params.sort as ContactSort)
    : "name";

  const filters = {
    q: params.q,
    company: params.company,
    minScore: params.minScore ? Number(params.minScore) : undefined,
    followUp: params.followUp === "due" ? ("due" as const) : undefined,
    sort,
    letter: params.letter,
  };

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
          : `${page.total.toLocaleString()} ${page.total === 1 ? "person" : "people"} in your network`
      }
      actions={
        <>
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
      <ContactQuotaNotice
        used={planOverview.usage.used}
        limit={planOverview.usage.limit}
      />
      <ContactsFilters
        initialQ={params.q || ""}
        initialCompany={params.company || ""}
        initialMinScore={params.minScore || ""}
        initialFollowUp={params.followUp || ""}
      >
        {/*
          Keyed on the filters so a new query starts from a clean list rather than appending
          onto the previous one's pages. Note this is the *filter* identity, not the contact
          data — the list used to be keyed on the latter, which meant every keystroke tore
          down and rebuilt the whole subtree.
        */}
        <ContactsList
          key={[params.q, params.company, params.minScore, params.followUp, sort].join("|")}
          initialItems={page.items}
          initialCursor={page.nextCursor}
          total={page.total}
          filters={filters}
          availableLetters={letters}
          activeLetter={params.letter ?? null}
        />
      </ContactsFilters>
    </PeopleListShell>
  );
}
