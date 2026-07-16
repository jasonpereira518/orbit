import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { getContact } from "@/actions/contacts";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ContactForm } from "@/components/contacts/contact-form";
import { DeleteContactButton } from "@/components/contacts/delete-contact-button";
import { cn } from "@/lib/utils";

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const contact = await getContact(id);
  if (!contact) notFound();

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/contacts" className="text-sm text-muted-foreground hover:underline">
            ← Contacts
          </Link>
          <h1 className="mt-2 font-[family-name:var(--font-display)] text-3xl text-[#0f3d3e]">
            {contact.fullName}
          </h1>
          <p className="mt-1 text-muted-foreground">
            {[contact.title, contact.company].filter(Boolean).join(" · ") ||
              "No role yet"}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge variant="outline">Score {contact.relationshipScore}</Badge>
            {contact.tags.map((t) => (
              <Badge key={t} variant="secondary">
                {t}
              </Badge>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/capture?contactId=${contact.id}`}
            className={cn(buttonVariants({ variant: "outline" }))}
          >
            Log interaction
          </Link>
          <DeleteContactButton id={contact.id} />
        </div>
      </div>

      {contact.aiSummary && (
        <Card className="border-border/70 shadow-none">
          <CardHeader>
            <CardTitle className="text-base">AI summary</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {contact.aiSummary}
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="border-border/70 shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Interaction timeline</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {contact.interactions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No interactions yet.</p>
            ) : (
              contact.interactions.map((i) => (
                <div key={i.id} className="border-l-2 border-[#0f3d3e]/30 pl-4">
                  <p className="text-xs text-muted-foreground">
                    {format(new Date(i.interactionDate), "MMM d, yyyy")} ·{" "}
                    {i.interactionType}
                  </p>
                  <p className="mt-1 text-sm">
                    {i.aiSummary || i.rawNotes || "Interaction logged"}
                  </p>
                  {(i.topics || []).length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {i.topics!.map((t) => (
                        <Badge key={t} variant="secondary" className="text-[10px]">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="border-border/70 shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Reminders</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {contact.reminders.length === 0 ? (
              <p className="text-sm text-muted-foreground">No reminders.</p>
            ) : (
              contact.reminders.map((r) => (
                <div key={r.id} className="rounded-lg border border-border/60 p-3">
                  <p className="font-medium">{r.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {r.status}
                    {r.dueDate
                      ? ` · due ${format(new Date(r.dueDate), "MMM d")}`
                      : ""}
                  </p>
                </div>
              ))
            )}
            {(contact.keyFacts || []).length > 0 && (
              <div className="pt-2">
                <p className="mb-2 text-sm font-medium">Key facts</p>
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {contact.keyFacts!.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div>
        <h2 className="mb-3 text-lg font-medium">Edit profile</h2>
        <ContactForm
          contactId={contact.id}
          initial={{
            fullName: contact.fullName,
            title: contact.title || "",
            company: contact.company || "",
            email: contact.email || "",
            linkedinUrl: contact.linkedinUrl || "",
            location: contact.location || "",
            howMet: contact.howMet || "",
            notes: contact.notes || "",
            relationshipScore: contact.relationshipScore,
            priorityLevel: contact.priorityLevel,
            tagNames: contact.tags,
          }}
        />
      </div>
    </div>
  );
}
