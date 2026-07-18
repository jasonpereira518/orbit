import Link from "next/link";
import { Plus } from "lucide-react";
import { listContacts } from "@/actions/contacts";
import { buttonVariants } from "@/components/ui/button";
import { ContactsFilters } from "@/components/contacts/contacts-filters";
import { ContactsList } from "@/components/contacts/contacts-list";
import { cn } from "@/lib/utils";

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; company?: string; minScore?: string }>;
}) {
  const params = await searchParams;
  const contacts = await listContacts({
    q: params.q,
    company: params.company,
    minScore: params.minScore ? Number(params.minScore) : undefined,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-3xl text-[#0f3d3e]">
            Contacts
          </h1>
          <p className="mt-1 text-muted-foreground">
            {contacts.length} people in your network
          </p>
        </div>
        <div className="flex gap-2">
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
              "bg-[#0f3d3e] text-white hover:bg-[#0c3233]"
            )}
          >
            <Plus className="mr-1 h-4 w-4" />
            Add contact
          </Link>
        </div>
      </div>

      <ContactsFilters
        initialQ={params.q || ""}
        initialCompany={params.company || ""}
        initialMinScore={params.minScore || ""}
      />

      <div className="overflow-hidden rounded-2xl border border-border/70 bg-white">
        <ContactsList
          key={[params.q, params.company, params.minScore].join("|")}
          initialContacts={contacts.map((c) => ({
            id: c.id,
            fullName: c.fullName,
            preferredName: c.preferredName,
            title: c.title,
            company: c.company,
            relationshipScore: c.relationshipScore,
            priorityLevel: c.priorityLevel,
            tags: c.tags,
          }))}
        />
      </div>
    </div>
  );
}
