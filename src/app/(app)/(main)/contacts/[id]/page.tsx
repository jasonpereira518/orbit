import { Suspense } from "react";
import { after } from "next/server";
import {
  getContact,
  getContactFollowUpSendOptions,
  listRelatedContacts,
} from "@/actions/contacts";
import { ContactBriefCard } from "@/components/contacts/contact-brief-card";
import { ContactExperienceSection } from "@/components/contacts/contact-experience-section";
import { ContactFollowUpSection } from "@/components/contacts/contact-follow-up-section";
import { ContactMentionsSection } from "@/components/contacts/contact-mentions-section";
import { ContactProfileHero } from "@/components/contacts/contact-profile-hero";
import { ContactProfileOverview } from "@/components/contacts/contact-profile-overview";
import { ContactRelatedPeople } from "@/components/contacts/contact-related-people";
import { ContactRemindersSection } from "@/components/contacts/contact-reminders-section";
import { ContactStatPills } from "@/components/contacts/contact-stat-pills";
import { ContactTimeline } from "@/components/contacts/contact-timeline";
import { Reveal } from "@/components/motion/reveal";
import { Skeleton } from "@/components/ui/skeleton";
import { computeCloseness, formatInteractionFrequency } from "@/lib/closeness";
import { getClosenessCohort } from "@/lib/closeness-cohort";
import { getConstellationConfig } from "@/lib/constellation-config";
import { constellationEligibility } from "@/lib/constellation-eligibility";
import { requireUserId } from "@/lib/auth";
import { listOpenActionItems } from "@/lib/action-items";
import {
  generateAndStoreContactBrief,
  getContactBrief,
  isBriefStale,
} from "@/lib/contact-brief";
import { listContactMentions } from "@/lib/contact-mentions";
import { getContactProfile } from "@/lib/contact-profile";
import { formatHowMetSummary } from "@/lib/met-context";
import { getSettings } from "@/actions/settings";
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
  // Guarded like the others: an unhandled getSettings() rejection would take the whole
  // page down for a section that only decides whether the add-notes card and the
  // experience section's "Fill from Apollo" button are enabled.
  const settingsPromise = getSettings().catch(() => ({
    hasApiKey: false,
    hasApolloKey: false,
  }));
  const relatedPromise = listRelatedContacts(id, 6).catch(() => []);
  // Started once and chained from below, rather than each `.then` re-calling
  // requireUserId(): the `after()` callback for brief regeneration needs the
  // resolved userId itself (a Server Component's `after` can't call
  // requireUserId()/auth() there — see the note below), so there needs to be
  // a single place upstream that resolves it during render.
  const userIdPromise = requireUserId();
  // Closeness is relative, so even a single-contact page needs the whole
  // orbit's distribution. Cached per request, and shared with any other
  // surface on this page that scores contacts.
  const cohortPromise = userIdPromise.then((userId) =>
    getClosenessCohort(userId)
  );
  const mentionsPromise = userIdPromise
    .then((u) => listContactMentions(u, id))
    .catch(() => ({ mentionedIn: [], mentions: [] }));
  const nextStepsPromise = userIdPromise
    .then((u) => listOpenActionItems(u, id))
    .catch(() => []);
  const briefPromise = userIdPromise
    .then((u) => getContactBrief(u, id))
    .catch(() => null);
  const profilePromise = userIdPromise
    .then((u) => getContactProfile(u, id))
    .catch(() => null);

  // notFound() must fire BEFORE any Suspense boundary renders so the route
  // still returns a real 404 status.
  const [contact, closenessCohort, constellationConfig] = await Promise.all([
    getContact(id),
    cohortPromise,
    getConstellationConfig(),
  ]);
  if (!contact) notFound();

  const brief = await briefPromise;
  const briefStale = isBriefStale(brief, contact.lastInteractionAt);
  if (briefStale) {
    // Regenerate off the request path: the page renders the last-known brief
    // (or the empty state) immediately, and the next visit picks up the
    // refreshed one. Errors here must never surface to the response.
    //
    // The userId is resolved here, during render, and closed over below —
    // NOT read inside the after() callback. Outside demo mode, requireUserId()
    // calls Clerk's auth(), which awaits headers(); a Server Component's
    // after() callback cannot call request-time APIs like headers()/cookies()
    // (see node_modules/next/dist/docs/.../functions/after.md), so
    // `after(() => requireUserId().then(...))` would throw there and never
    // regenerate the brief in production.
    const userId = await userIdPromise;
    after(() => generateAndStoreContactBrief(userId, id).catch(() => null));
  }

  const closeness =
    closenessCohort.byId.get(contact.id) ??
    // Only reachable if the contact was created after the cohort query ran.
    //
    // This is a deliberately approximate fallback, not a second scoring path
    // pretending to be the real one. `statedCloseness`, `firstInteractionAt`
    // and `dateMet` are per-contact columns already sitting on `contact`
    // (getContact() has no `columns` restriction), so they're passed straight
    // through — no reason to score a rated contact as if unrated just because
    // it missed the cohort by a race.
    //
    // The four affinity fields (`emailDomainMatchesUser`, `companyConcentration`,
    // `schoolConcentration`, `coveredByConnectedSource`) are NOT reproduced here.
    // They are orbit-relative — computed in closeness-cohort.ts from every one
    // of the user's contacts (max company/school share across the whole orbit,
    // the user's own email domain, whether Gmail/Outlook is connected) — so
    // getting them right for one contact means re-running that whole scan, at
    // which point this "fallback" is just `getClosenessCohort` again with extra
    // steps. Left at their default (falsy/0), this contact's `prior` is a bit
    // more conservative than its peers until the next request rebuilds the
    // cohort and it takes its real place. An honestly-approximate fallback
    // beats one that silently claims full fidelity.
    computeCloseness(
      {
        relationshipScore: contact.relationshipScore,
        statedCloseness: contact.statedCloseness,
        lastInteractionAt: contact.lastInteractionAt,
        // `getContact` loads this contact's interaction rows unfiltered, so
        // this is the same has-ever-interacted fact the cohort builder derives
        // from the interactions table — not the `lastInteractionAt` stamp,
        // which every create path writes.
        hasLoggedInteraction: contact.interactions.length > 0,
        firstInteractionAt: contact.firstInteractionAt,
        dateMet: contact.dateMet,
        createdAt: contact.createdAt,
        company: contact.company,
        title: contact.title,
        industry: contact.industry,
        howMet: contact.howMet,
        aiSummary: contact.aiSummary,
        keyFacts: contact.keyFacts,
        sharedInterests: contact.sharedInterests,
        tags: contact.tags,
      },
      closenessCohort.goals,
      {
        cohort: closenessCohort.cohort,
        touchCount: closenessCohort.touchCounts.get(contact.id) ?? 0,
      }
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
  // Same distinction the closeness model already makes: `lastInteractionAt` is stamped on
  // every create/import, so only an actual interactions row proves a touch happened.
  const hasLoggedInteraction = contact.interactions.length > 0;

  const frequencyLabel = formatInteractionFrequency(
    contact.interactions.map((i) => i.interactionDate)
  );

  // Awaited once here rather than inline: both the brief card's next-steps list and the
  // timeline's per-interaction "N open" chips read the same rows.
  const nextSteps = await nextStepsPromise;

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
    // Not for display — the Strength field renders `relationshipScore`. This is
    // how the form knows whether that number is an actual assessment or just
    // the import default, so it can avoid re-asserting a rating nobody made.
    statedCloseness: contact.statedCloseness,
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
        <ContactStatPills
          closeness={closeness}
          lastTouchAt={lastTouchAt}
          hasLoggedInteraction={hasLoggedInteraction}
          constellation={
            constellationConfig.enabled
              ? {
                  contactId: contact.id,
                  pin: contact.constellationPin,
                  // What "Automatic" resolves to for this person right now, so the pill can
                  // answer "are they on my chart?" without opening the menu.
                  substantive: constellationEligibility(
                    closenessCohort.constellationSignals.get(contact.id),
                    {
                      pin: null,
                      hasNotesText: Boolean(contact.notes?.trim()),
                      statedCloseness: contact.statedCloseness,
                      priorityLevel: contact.priorityLevel,
                      nextFollowUpAt: contact.nextFollowUpAt,
                      tagCount: contact.tags.length,
                    },
                    constellationConfig.thresholds
                  ).eligible,
                }
              : undefined
          }
        />
      </div>

      <div
        className="reveal-mount"
        style={{ "--reveal-delay": "90ms" } as React.CSSProperties}
      >
        <ContactBriefCard
          contactId={contact.id}
          standing={brief?.standing ?? null}
          recentDiscussions={brief?.recentDiscussions ?? []}
          nextSteps={nextSteps.map((item) => ({
            ...item,
            interactionDate: new Date(item.interactionDate).toISOString(),
          }))}
          stale={briefStale}
        />
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
          hasLoggedInteraction={hasLoggedInteraction}
          frequencyLabel={frequencyLabel}
          howMetSummary={howMetSummary}
        />
      </div>

      {/* No fallback: the section renders its own empty state, and a skeleton that
          resolves into an empty state reads as a glitch. */}
      <Suspense fallback={null}>
        <StreamedExperience
          data={profilePromise}
          settings={settingsPromise}
          contactId={contact.id}
          linkedinUrl={contact.linkedinUrl}
        />
      </Suspense>

      <Suspense fallback={<Skeleton className="h-40 w-full rounded-2xl" />}>
        <StreamedFollowUp
          sendOptions={sendOptionsPromise}
          contactId={contact.id}
          contactName={displayName}
          nextFollowUpAt={contact.nextFollowUpAt}
          phone={contact.phone}
        />
      </Suspense>

      {/* Streamed so the settings read never blocks the rest of the profile. The timeline
          needs it: whether an AI key is configured decides whether logging an interaction
          extracts a summary or just files the note as written. */}
      <Suspense fallback={<Skeleton className="h-96 w-full rounded-2xl" />}>
        <StreamedTimeline
          settings={settingsPromise}
          contactId={contact.id}
          contactName={displayName}
          interactions={contact.interactions.map((i) => ({
            id: i.id,
            interactionType: i.interactionType,
            interactionDate: i.interactionDate,
            sameDayOrder: i.sameDayOrder,
            notesPreview: i.notesPreview,
            aiSummary: i.aiSummary,
          }))}
          openActionItems={nextSteps.map((item) => ({
            id: item.id,
            interactionId: item.interactionId,
          }))}
        />
      </Suspense>

      <Reveal>
        <ContactRemindersSection reminders={contact.reminders ?? []} />
      </Reveal>

      {/* No fallback here: this section renders nothing when empty, and a
          skeleton that can collapse into nothing reads as a glitch. */}
      <Suspense fallback={null}>
        <StreamedMentions data={mentionsPromise} />
      </Suspense>

      {/* No fallback here: this section renders nothing when empty, and a
          skeleton that can collapse into nothing reads as a glitch. */}
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

async function StreamedTimeline({
  settings,
  ...rest
}: {
  settings: Promise<{ hasApiKey: boolean }>;
  contactId: string;
  contactName: string;
  interactions: React.ComponentProps<typeof ContactTimeline>["interactions"];
  openActionItems: React.ComponentProps<
    typeof ContactTimeline
  >["openActionItems"];
}) {
  const { hasApiKey } = await settings;
  return (
    <div className="reveal-mount">
      <ContactTimeline {...rest} hasApiKey={hasApiKey} />
    </div>
  );
}

async function StreamedExperience({
  data,
  settings,
  contactId,
  linkedinUrl,
}: {
  data: Promise<Awaited<ReturnType<typeof getContactProfile>>>;
  // Consumed here rather than awaited in the parent (unlike the brief's original
  // sketch): `settingsPromise` is meant to stream — StreamedAddNotes below awaits
  // the same promise inside its own Suspense boundary for the same reason — so
  // awaiting it in the page body above this component's JSX would block everything
  // that follows on the settings read finishing first.
  settings: Promise<{ hasApolloKey: boolean }>;
  contactId: string;
  linkedinUrl: string | null;
}) {
  const [profile, { hasApolloKey }] = await Promise.all([data, settings]);
  return (
    <div className="reveal-mount">
      <ContactExperienceSection
        contactId={contactId}
        linkedinUrl={linkedinUrl}
        canUseApollo={hasApolloKey}
        profile={
          profile && {
            source: profile.source,
            capturedAt: profile.capturedAt.toISOString(),
            warnings: profile.warnings,
            headline: profile.headline,
            about: profile.about,
            skills: profile.skills.map((s) => s.name),
            certifications: profile.certifications.map((c) => c.name),
            volunteering: profile.volunteering.map((v) => v.organization),
            publications: profile.publications.map((p) => p.title),
            experiences: profile.experiences,
          }
        }
      />
    </div>
  );
}

async function StreamedMentions({
  data,
}: {
  data: ReturnType<typeof listContactMentions>;
}) {
  const { mentionedIn, mentions } = await data;
  if (mentionedIn.length === 0 && mentions.length === 0) return null;
  return (
    <div className="reveal-mount">
      <ContactMentionsSection mentionedIn={mentionedIn} mentions={mentions} />
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
