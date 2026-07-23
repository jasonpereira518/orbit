import {
  getContact,
  getContactFollowUpSendOptions,
  listRelatedContacts,
} from "@/actions/contacts";
import { listActiveGoalTexts } from "@/actions/goals";
import { ContactFollowUpSection } from "@/components/contacts/contact-follow-up-section";
import { ContactProfileHero } from "@/components/contacts/contact-profile-hero";
import { ContactProfileOverview } from "@/components/contacts/contact-profile-overview";
import { ContactRelatedPeople } from "@/components/contacts/contact-related-people";
import { ContactRemindersSection } from "@/components/contacts/contact-reminders-section";
import { ContactStatPills } from "@/components/contacts/contact-stat-pills";
import { ContactTimeline } from "@/components/contacts/contact-timeline";
import {
  computeCloseness,
  formatInteractionFrequency,
} from "@/lib/closeness";
import { formatHowMetSummary } from "@/lib/met-context";
import { requireUserId } from "@/lib/auth";
import { notFound } from "next/navigation";

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
    listRelatedContacts(contact.id, 6),
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

      <ContactStatPills closeness={closeness} lastTouchAt={lastTouchAt} />

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

      <ContactFollowUpSection
        contactId={contact.id}
        contactName={displayName}
        nextFollowUpAt={contact.nextFollowUpAt}
        sendOptions={sendOptions}
        phone={contact.phone}
      />

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

      <ContactRemindersSection reminders={contact.reminders ?? []} />

      <ContactRelatedPeople people={relatedPeople} subjectName={displayName} />
    </div>
  );
}
