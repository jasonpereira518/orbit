import Link from "next/link";
import { notFound } from "next/navigation";
import { format, formatDistanceToNow } from "date-fns";
import {
  getContact,
  getContactFollowUpSendOptions,
  listRelatedContacts,
} from "@/actions/contacts";
import { listActiveGoalTexts } from "@/actions/goals";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ContactAiSummary } from "@/components/contacts/contact-ai-summary";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { ContactEditSheet } from "@/components/contacts/contact-edit-sheet";
import { ContactQuickActions } from "@/components/contacts/contact-quick-actions";
import { ContactRelatedPeople } from "@/components/contacts/contact-related-people";
import { ContactSuggestedMessage } from "@/components/contacts/contact-suggested-message";
import { computeCloseness } from "@/lib/closeness";
import { formatHowMetSummary } from "@/lib/met-context";
import { requireUserId } from "@/lib/auth";

function relationshipBlurb(input: {
  aiSummary: string | null;
  howMetSummary: string | null;
  tier: string;
  preferredName: string;
}): string {
  const summary = input.aiSummary?.trim();
  if (summary) {
    const first = summary.split(/(?<=[.!?])\s+/)[0]?.trim();
    if (first && first.length <= 220) return first;
    if (first) return `${first.slice(0, 200).trim()}…`;
    return summary.slice(0, 200).trim() + (summary.length > 200 ? "…" : "");
  }
  if (input.howMetSummary) {
    return `${input.preferredName} is in your ${input.tier} orbit. How you met: ${input.howMetSummary}.`;
  }
  return `${input.preferredName} is in your ${input.tier} orbit. Add how you met or log an interaction to enrich this profile.`;
}

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [contact, userId] = await Promise.all([getContact(id), requireUserId()]);
  if (!contact) notFound();

  const [goals, relatedPeople, sendOptions] = await Promise.all([
    listActiveGoalTexts(userId),
    listRelatedContacts(contact.id),
    getContactFollowUpSendOptions(contact.id),
  ]);

  const closeness = computeCloseness(
    {
      relationshipScore: contact.relationshipScore,
      lastInteractionAt: contact.lastInteractionAt,
      createdAt: contact.createdAt,
      company: contact.company,
      title: contact.title,
      industry: contact.industry,
      howMet: contact.howMet,
      notes: contact.notes,
      aiSummary: contact.aiSummary,
      keyFacts: contact.keyFacts,
      sharedInterests: contact.sharedInterests,
      tags: contact.tags,
    },
    goals
  );

  const howMetSummary = formatHowMetSummary({
    metContext: contact.metContext,
    dateMet: contact.dateMet,
    howMet: contact.howMet,
  });

  const displayName = contact.preferredName || contact.fullName;
  const blurb = relationshipBlurb({
    aiSummary: contact.aiSummary,
    howMetSummary,
    tier: closeness.tier,
    preferredName: displayName,
  });

  const latestInteraction = contact.interactions[0] ?? null;
  const lastTouchAt =
    latestInteraction?.interactionDate || contact.lastInteractionAt;

  const profileFields: {
    label: string;
    value: string;
    href?: string;
  }[] = [
    { label: "Full name", value: contact.fullName },
    ...(contact.preferredName
      ? [{ label: "Preferred name", value: contact.preferredName }]
      : []),
    ...(contact.company
      ? [{ label: "Company", value: contact.company }]
      : []),
    ...(contact.title ? [{ label: "Role", value: contact.title }] : []),
    ...(contact.location
      ? [{ label: "Location", value: contact.location }]
      : []),
    ...(contact.school ? [{ label: "School", value: contact.school }] : []),
    ...(howMetSummary
      ? [{ label: "How you met", value: howMetSummary }]
      : []),
    ...(contact.email
      ? [
          {
            label: "Email",
            value: contact.email,
            href: `mailto:${contact.email}`,
          },
        ]
      : []),
    ...(contact.phone
      ? [
          {
            label: "Phone",
            value: contact.phone,
            href: `tel:${contact.phone}`,
          },
        ]
      : []),
    ...(contact.linkedinUrl
      ? [
          {
            label: "LinkedIn URL",
            value: contact.linkedinUrl,
            href: contact.linkedinUrl,
          },
        ]
      : []),
    ...(contact.website
      ? [
          {
            label: "Website",
            value: contact.website,
            href: contact.website,
          },
        ]
      : []),
  ];

  const keyFacts = contact.keyFacts || [];

  const formInitial = {
    fullName: contact.fullName,
    preferredName: contact.preferredName || "",
    title: contact.title || "",
    company: contact.company || "",
    location: contact.location || "",
    school: contact.school || "",
    metContext: contact.metContext || "",
    dateMet: contact.dateMet
      ? new Date(contact.dateMet).toISOString().slice(0, 10)
      : "",
    howMet: contact.howMet || "",
    email: contact.email || "",
    phone: contact.phone || "",
    linkedinUrl: contact.linkedinUrl || "",
    website: contact.website || "",
    notes: contact.notes || "",
    relationshipScore: contact.relationshipScore,
    priorityLevel: contact.priorityLevel,
    tagNames: contact.tags,
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <Link
            href="/contacts"
            className="text-sm text-muted-foreground hover:underline"
          >
            ← Contacts
          </Link>
          <div className="mt-3 flex gap-4">
            <ContactAvatar
              contactId={contact.id}
              firstName={contact.firstName}
              fullName={contact.fullName}
              linkedinUrl={contact.linkedinUrl}
              profileImageUrl={contact.profileImageUrl}
              size="lg"
              className="size-16 shrink-0 sm:size-20"
            />
            <div className="min-w-0">
              <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">
                {displayName}
              </h1>
              {contact.preferredName &&
                contact.preferredName !== contact.fullName && (
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {contact.fullName}
                  </p>
                )}
              <p className="mt-1 text-muted-foreground">
                {[contact.title, contact.company].filter(Boolean).join(" · ") ||
                  "No role yet"}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Badge variant="outline">
                  Closeness {Math.round(closeness.closeness * 100)}%
                </Badge>
                <Badge variant="secondary" className="capitalize">
                  {closeness.tier} orbit
                </Badge>
                <Badge variant="outline">
                  Manual {contact.relationshipScore}/5
                </Badge>
                {contact.tags.map((t) => (
                  <Badge key={t} variant="secondary">
                    {t}
                  </Badge>
                ))}
              </div>
            </div>
          </div>

          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {blurb}
          </p>

          <p className="mt-2 text-sm text-primary/80">
            {lastTouchAt ? (
              <>
                Last interaction{" "}
                {formatDistanceToNow(new Date(lastTouchAt), {
                  addSuffix: true,
                })}
                {latestInteraction
                  ? ` · ${
                      (
                        latestInteraction.aiSummary ||
                        latestInteraction.rawNotes ||
                        latestInteraction.interactionType
                      )?.slice(0, 120) || latestInteraction.interactionType
                    }`
                  : null}
              </>
            ) : (
              "No interactions logged yet"
            )}
          </p>
        </div>

        <ContactEditSheet
          contactId={contact.id}
          name={displayName}
          initial={formInitial}
        />
      </div>

      <ContactQuickActions
        contactId={contact.id}
        nextFollowUpAt={contact.nextFollowUpAt}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        {profileFields.length > 0 ? (
          <Card className="border-border/70 shadow-none">
            <CardHeader>
              <CardTitle className="text-base">Profile</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 sm:grid-cols-2">
                {profileFields.map((field) => (
                  <div key={field.label} className="min-w-0">
                    <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {field.label}
                    </dt>
                    <dd className="mt-1 truncate text-sm text-primary">
                      {field.href ? (
                        <a
                          href={field.href}
                          target={
                            field.href.startsWith("http") ? "_blank" : undefined
                          }
                          rel={
                            field.href.startsWith("http")
                              ? "noopener noreferrer"
                              : undefined
                          }
                          className="underline-offset-2 hover:underline"
                        >
                          {field.value}
                        </a>
                      ) : (
                        field.value
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        ) : null}

        <Card className="border-border/70 shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Key facts</CardTitle>
          </CardHeader>
          <CardContent>
            {keyFacts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No key facts yet. They appear when you capture notes or enrich
                this contact.
              </p>
            ) : (
              <ul className="list-disc space-y-1.5 pl-5 text-sm text-primary">
                {keyFacts.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="border-border/70 shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Closeness breakdown</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm sm:grid-cols-3">
          <div className="rounded-xl border border-border/60 p-3">
            <p className="text-xs text-muted-foreground">Strength (50%)</p>
            <p className="mt-1 font-medium text-primary">
              {Math.round(closeness.strength * 100)}%
            </p>
          </div>
          <div className="rounded-xl border border-border/60 p-3">
            <p className="text-xs text-muted-foreground">Recency (30%)</p>
            <p className="mt-1 font-medium text-primary">
              {Math.round(closeness.recency * 100)}%
            </p>
          </div>
          <div className="rounded-xl border border-border/60 p-3">
            <p className="text-xs text-muted-foreground">Goals (20%)</p>
            <p className="mt-1 font-medium text-primary">
              {Math.round(closeness.goalRelevance * 100)}%
            </p>
          </div>
        </CardContent>
      </Card>

      <ContactAiSummary contactId={contact.id} summary={contact.aiSummary} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          id="interaction-timeline"
          className="scroll-mt-24 border-border/70 shadow-none"
        >
          <CardHeader>
            <CardTitle className="text-base">Interaction timeline</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {contact.interactions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No interactions yet.
              </p>
            ) : (
              contact.interactions.map((i) => (
                <div key={i.id} className="border-l-2 border-primary/30 pl-4">
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
                        <Badge
                          key={t}
                          variant="secondary"
                          className="text-[10px]"
                        >
                          {t}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {(i.actionItems || []).length > 0 && (
                    <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                      {i.actionItems!.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
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
                <div
                  key={r.id}
                  className="rounded-lg border border-border/60 p-3"
                >
                  <p className="font-medium">{r.title}</p>
                  {r.description?.trim() ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {r.description}
                    </p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    {r.status}
                    {r.dueDate
                      ? ` · due ${format(new Date(r.dueDate), "MMM d")}`
                      : ""}
                  </p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <ContactSuggestedMessage
        contactId={contact.id}
        contactName={displayName}
        sendOptions={sendOptions}
      />

      <ContactRelatedPeople people={relatedPeople} />
    </div>
  );
}
