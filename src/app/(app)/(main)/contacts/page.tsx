import Link from "next/link";
import { listContacts } from "@/actions/contacts";
import { ContactsFilters } from "@/components/contacts/contacts-filters";
import { ContactsList } from "@/components/contacts/contacts-list";
import { ContactsPageActions } from "@/components/contacts/contacts-page-actions";
import { PeopleListShell } from "@/components/contacts/people-list-shell";

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
      actions={<ContactsPageActions />}
      >
        <ContactsFilters
          key={[params.q, params.company, params.minScore, params.followUp].join("|")}
          initialQ={params.q || ""}
          initialCompany={params.company || ""}
          initialMinScore={params.minScore || ""}
          initialFollowUp={params.followUp || ""}
        >
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
        </ContactsFilters>
    </PeopleListShell>
  );
}
