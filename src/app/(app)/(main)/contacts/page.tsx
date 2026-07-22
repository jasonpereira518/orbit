import Link from "next/link";
import { Plus } from "lucide-react";
import { listContacts } from "@/actions/contacts";
import { buttonVariants } from "@/components/ui/button";
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
  }>;
}) {
  const params = await searchParams;
  const contacts = await listContacts({
    q: params.q,
    company: params.company,
    minScore: params.minScore ? Number(params.minScore) : undefined,
    followUp: params.followUp === "due" ? "due" : undefined,
  });

  return (
    <PeopleListShell
      active="contacts"
      title="Contacts"
      subtitle={`${contacts.length} people in your network`}
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
      <div className="space-y-6">
        <ContactsFilters
          initialQ={params.q || ""}
          initialCompany={params.company || ""}
          initialMinScore={params.minScore || ""}
          initialFollowUp={params.followUp || ""}
        />

        <div className="rounded-2xl border border-border/70 bg-card">
          <ContactsList
            key={[params.q, params.company, params.minScore, params.followUp].join(
              "|"
            )}
            initialContacts={contacts.map((c) => ({
              id: c.id,
              fullName: c.fullName,
              firstName: c.firstName,
              lastName: c.lastName,
              preferredName: c.preferredName,
              title: c.title,
              company: c.company,
              school: c.school,
              location: c.location,
              linkedinUrl: c.linkedinUrl,
              profileImageUrl: c.profileImageUrl,
              relationshipScore: c.relationshipScore,
              closeness: c.closeness,
              closenessTier: c.closenessTier,
              priorityLevel: c.priorityLevel,
              nextFollowUpAt: c.nextFollowUpAt,
              lastInteractionAt: c.lastInteractionAt,
              tags: c.tags,
            }))}
          />
        </div>
      </div>
    </PeopleListShell>
  );
}
