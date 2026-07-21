import Link from "next/link";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RelatedContact } from "@/lib/related-contacts";

export function ContactRelatedPeople({
  people,
}: {
  people: RelatedContact[];
}) {
  if (people.length === 0) return null;

  return (
    <Card className="border-border/70 shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Related people</CardTitle>
        <p className="text-xs text-muted-foreground">
          Linked by company, school, how you met, mentions, or shared tags.
        </p>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-3 sm:grid-cols-2">
          {people.map((person) => {
            const display =
              person.preferredName?.trim() || person.fullName;
            return (
              <li key={person.id}>
                <Link
                  href={`/contacts/${person.id}`}
                  className="flex items-center gap-3 rounded-xl border border-border/60 p-3 transition-colors hover:bg-muted/40"
                >
                  <ContactAvatar
                    contactId={person.id}
                    firstName={person.firstName}
                    fullName={person.fullName}
                    linkedinUrl={person.linkedinUrl}
                    profileImageUrl={person.profileImageUrl}
                    size="default"
                    className="size-10"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-primary">
                      {display}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {[person.title, person.company].filter(Boolean).join(" · ") ||
                        "No role yet"}
                    </p>
                    <Badge
                      variant="secondary"
                      className="mt-1 max-w-full truncate text-[10px] font-normal"
                    >
                      {person.reasonLabel}
                    </Badge>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
