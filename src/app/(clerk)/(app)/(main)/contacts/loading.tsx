import { ContactsPageSkeleton } from "@/components/loading/page-skeletons";
import { PeopleNavFallback } from "@/components/contacts/people-nav-fallback";

export default function ContactsLoading() {
  return (
    <PeopleNavFallback
      active="contacts"
      title="Contacts"
      subtitle="Your network"
      skeleton={<ContactsPageSkeleton />}
    />
  );
}
