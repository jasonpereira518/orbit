import { Suspense } from "react";
import {
  getContact,
  getContactFollowUpSendOptions,
  listRelatedContacts,
  listMutualContacts,
} from "@/actions/contacts";
import { listActiveGoalTexts } from "@/actions/goals";
import { ContactFollowUpSection } from "@/components/contacts/contact-follow-up-section";
import { ContactProfileHero } from "@/components/contacts/contact-profile-hero";
import { ContactProfileOverview } from "@/components/contacts/contact-profile-overview";
import { ContactRelatedPeople } from "@/components/contacts/contact-related-people";
import { ContactMutualPeople } from "@/components/contacts/contact-mutual-people";
import { ContactRemindersSection } from "@/components/contacts/contact-reminders-section";
import { ContactStatPills } from "@/components/contacts/contact-stat-pills";
import { ContactTimeline } from "@/components/contacts/contact-timeline";
import { Reveal } from "@/components/motion/reveal";
import { Skeleton } from "@/components/ui/skeleton";
import {
  computeCloseness,
  formatInteractionFrequency,
} from "@/lib/closeness";
import { formatHowMetSummary } from "@/lib/met-context";
import { notFound } from "next/navigation";

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Every side query needs only the route param — start them all before the
  // first await so nothing serializes behind getContact. The .catch wrappers
  // keep an eagerly-started promise from surfacing an unhandled rejection
  // (or racing notFound() into the error boundary on a bogus id); on
  // failure the section simply doesn't render.
  const sendOptionsPromise = getContactFollowUpSendOptions(id).catch(() => null);
  const relatedPromise = listRelatedContacts(id, 6).catch(() => []);
  const mutualsPromise = listMutualContacts(id, 6).catch(() => []);
  // listActiveGoalTexts resolves the user internally as of the goals rework.
  const goalsPromise = listActiveGoalTexts();

  // notFound() must fire BEFORE any Suspense boundary renders so the route
  // still returns a real 404 status.
  const [contact, goals] = await Promise.all([getContact(id), goalsPromise]);
  if (!contact) notFound();

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
  const latestInteraction = contact.interactions[0] ?? null;
  const lastTouchAt =
    latestInteraction?.interactionDate || contact.lastInteractionAt;

  const frequencyLabel = formatInteractionFrequency(
    contact.interactions.map((i) => i.interactionDate)
  );

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
    industry: contact.industry || "",
    sharedInterests: contact.sharedInterests || [],
    relationshipScore: contact.relationshipScore,
    priorityLevel: contact.priorityLevel,
    tagNames: contact.tags,
  };

  const channels = {
    email: contact.email,
    phone: contact.phone,
    linkedinUrl: contact.linkedinUrl,
    website: contact.website,
  };

  return (
    <div className="space-y-6 pb-8">
      <div className="reveal-mount">
        <ContactProfileHero
          contactId={contact.id}
          displayName={displayName}
          fullName={contact.fullName}
          preferredName={contact.preferredName}
          firstName={contact.firstName}
          title={contact.title}
          company={contact.company}
          school={contact.school}
          location={contact.location}
          profileImageUrl={contact.profileImageUrl}
          linkedinUrl={contact.linkedinUrl}
          channels={channels}
          formInitial={formInitial}
        />
      </div>

      <div
        className="reveal-mount"
        style={{ "--reveal-delay": "60ms" } as React.CSSProperties}
      >
        <ContactStatPills closeness={closeness} lastTouchAt={lastTouchAt} />
      </div>

      <div
        className="reveal-mount"
        style={{ "--reveal-delay": "120ms" } as React.CSSProperties}
      >
        <ContactProfileOverview
          contactId={contact.id}
          aiSummary={contact.aiSummary}
          keyFacts={contact.keyFacts || []}
          sharedInterests={contact.sharedInterests || []}
          industry={contact.industry}
          closeness={closeness}
          lastTouchAt={lastTouchAt}
          frequencyLabel={frequencyLabel}
          howMetSummary={howMetSummary}
        />
      </div>

      <Suspense fallback={<Skeleton className="h-40 w-full rounded-2xl" />}>
        <StreamedFollowUp
          sendOptions={sendOptionsPromise}
          contactId={contact.id}
          contactName={displayName}
          nextFollowUpAt={contact.nextFollowUpAt}
          phone={contact.phone}
        />
      </Suspense>

      <Reveal>
        <ContactTimeline
          contactId={contact.id}
          interactions={contact.interactions.map((i) => ({
            id: i.id,
            interactionType: i.interactionType,
            interactionDate: i.interactionDate,
            sameDayOrder: i.sameDayOrder,
            rawNotes: i.rawNotes,
            aiSummary: i.aiSummary,
            actionItems: i.actionItems,
          }))}
        />
      </Reveal>

      <Reveal>
        <ContactRemindersSection reminders={contact.reminders ?? []} />
      </Reveal>

      {/* No fallbacks here: these sections render nothing when empty, and a
          skeleton that can collapse into nothing reads as a glitch. */}
      <Suspense fallback={null}>
        <StreamedMutuals mutuals={mutualsPromise} subjectName={displayName} />
      </Suspense>

      <Suspense fallback={null}>
        <StreamedRelated people={relatedPromise} subjectName={displayName} />
      </Suspense>
    </div>
  );
}

async function StreamedFollowUp({
  sendOptions,
  ...rest
}: {
  sendOptions: Promise<Awaited<
    ReturnType<typeof getContactFollowUpSendOptions>
  > | null>;
  contactId: string;
  contactName: string;
  nextFollowUpAt: Date | string | null;
  phone: string | null;
}) {
  const resolved = await sendOptions;
  if (!resolved) return null;
  return (
    <div className="reveal-mount">
      <ContactFollowUpSection {...rest} sendOptions={resolved} />
    </div>
  );
}

async function StreamedMutuals({
  mutuals,
  subjectName,
}: {
  mutuals: ReturnType<typeof listMutualContacts>;
  subjectName: string;
}) {
  const resolved = await mutuals;
  if (resolved.length === 0) return null;
  return (
    <div className="reveal-mount">
      <ContactMutualPeople mutuals={resolved} subjectName={subjectName} />
    </div>
  );
}

async function StreamedRelated({
  people,
  subjectName,
}: {
  people: ReturnType<typeof listRelatedContacts>;
  subjectName: string;
}) {
  const resolved = await people;
  if (resolved.length === 0) return null;
  return (
    <div className="reveal-mount">
      <ContactRelatedPeople people={resolved} subjectName={subjectName} />
    </div>
  );
}
