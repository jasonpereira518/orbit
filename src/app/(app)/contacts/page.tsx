import Link from "next/link";
import { Plus } from "lucide-react";
import { listContacts } from "@/actions/contacts";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { ContactsFilters } from "@/components/contacts/contacts-filters";
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
        {contacts.length === 0 ? (
          <div className="p-10 text-center text-muted-foreground">
            No contacts yet.{" "}
            <Link href="/capture" className="text-[#0f3d3e] underline">
              Capture notes
            </Link>{" "}
            or{" "}
            <Link href="/imports" className="text-[#0f3d3e] underline">
              import LinkedIn
            </Link>
            .
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {contacts.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/contacts/${c.id}`}
                  className="flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-muted/40"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-[#0f3d3e]">{c.fullName}</p>
                    <p className="truncate text-sm text-muted-foreground">
                      {[c.title, c.company].filter(Boolean).join(" · ") ||
                        "No role yet"}
                    </p>
                    {c.tags.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {c.tags.slice(0, 4).map((t) => (
                          <Badge key={t} variant="secondary" className="text-[10px]">
                            {t}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge variant="outline">Score {c.relationshipScore}</Badge>
                    {c.priorityLevel > 0 && (
                      <span className="text-[10px] uppercase tracking-wide text-[#c4a35a]">
                        Priority {c.priorityLevel}
                      </span>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
