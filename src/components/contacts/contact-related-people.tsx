import Link from "next/link";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { ContactAvatarPreview } from "@/components/contacts/contact-preview-card";
import { ContactRelatedReachOut } from "@/components/contacts/contact-related-reach-out";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { RelatedContact } from "@/lib/related-contacts";

export function ContactRelatedPeople({
  people,
  subjectName,
}: {
  people: RelatedContact[];
  subjectName: string;
}) {
  if (people.length === 0) return null;

  return (
    <Card className="border-border/70 shadow-none">
      <CardHeader>
        <CardTitle>Related people</CardTitle>
        <CardDescription>
          Strongest connections and useful intro paths for {subjectName}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-3 sm:grid-cols-2">
          {people.map((person) => {
            const display =
              person.preferredName?.trim() || person.fullName;
            return (
              <li
                key={person.id}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-border/50 p-3"
              >
                <ContactAvatarPreview
                  className="min-w-0 flex-1"
                  contact={{
                    id: person.id,
                    fullName: person.fullName,
                    firstName: person.firstName,
                    preferredName: person.preferredName,
                    title: person.title,
                    company: person.company,
                    school: person.school,
                    location: person.location,
                    linkedinUrl: person.linkedinUrl,
                    profileImageUrl: person.profileImageUrl,
                    summary: person.aiSummary,
                    detail: person.reasonLabel,
                  }}
                >
                  <Link
                    href={`/contacts/${person.id}`}
                    className="flex min-w-0 flex-1 items-center gap-3 transition-opacity hover:opacity-80"
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
                        {[person.title, person.company]
                          .filter(Boolean)
                          .join(" · ") || "No role yet"}
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {person.reasonLabel}
                      </p>
                    </div>
                  </Link>
                </ContactAvatarPreview>
                <ContactRelatedReachOut
                  contactId={person.id}
                  contactName={display}
                  subjectName={subjectName}
                  email={person.email}
                  linkedinUrl={person.linkedinUrl}
                  phone={person.phone}
                />
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
