import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import {
  actionItems,
  chatMessages,
  chatThreads,
  contactBriefs,
  contactExperiences,
  contactIdentities,
  contactProfiles,
  contactTags,
  contacts,
  eventAttendees,
  events,
  imports,
  interactions,
  outreachCampaigns,
  outreachMessages,
  outreachProspects,
  recruiterMessages,
  recruiters,
  reminderLists,
  reminders,
  suggestedReminders,
  tags,
  userGoals,
  userRecruiterLinks,
  userSettings,
  type ChatRecommendation,
  type NewContact,
} from "@/db/schema";
import { actionItemHash } from "@/lib/action-items";
import { markCohortDirty } from "@/lib/closeness-materialize";
import { createCompanyResolver } from "@/lib/companies";
import { normalizeCompanyKey } from "@/lib/company-name";
import { buildRecentDiscussions } from "@/lib/contact-brief";
import { identityKeysFor } from "@/lib/duplicates";
import {
  normalizeEmail,
  normalizeFirm,
  normalizePersonName,
  recomputeRecruiterRating,
} from "@/lib/recruiters";
import { getInboxListId } from "@/lib/reminder-lists";
import { DEMO_GOALS, DEMO_PEOPLE, type DemoPerson } from "@/lib/demo-data/network";

/** Written to every seeded row that has a `source`, so demo rows can always be told apart. */
export const DEMO_SOURCE = "demo-seed";

const DAY = 86_400_000;

export type DemoSeedSummary = Record<string, number>;

/**
 * Fill an account with the demo workspace: the network, its timelines and briefs, and a
 * populated version of every other surface — reminders, outreach, recruiters, events,
 * chat, imports and goals.
 *
 * Assumes the account has no contacts; callers check. Not atomic (`db.transaction` is dead
 * on neon-http), so each surface after the network is written independently and a failure
 * in one is logged rather than taking the rest down with it.
 */
export async function seedDemoWorkspace(userId: string): Promise<DemoSeedSummary> {
  const now = Date.now();
  const ago = (days: number) => new Date(now - days * DAY);
  const ahead = (days: number) => new Date(now + days * DAY);

  const summary: DemoSeedSummary = {};
  const contactIdByName = await seedNetwork(userId, ago, ahead, summary);

  const surfaces: Array<[string, () => Promise<void>]> = [
    ["reminders", () => seedReminders(userId, contactIdByName, ahead, summary)],
    ["outreach", () => seedOutreach(userId, contactIdByName, ago, summary)],
    ["recruiters", () => seedRecruiters(userId, contactIdByName, ago, summary)],
    ["events", () => seedEvents(userId, contactIdByName, ago, ahead, summary)],
    ["chat", () => seedChat(userId, contactIdByName, ago, summary)],
    ["imports", () => seedImports(userId, ago, summary)],
    ["goals", () => seedGoals(userId, summary)],
  ];
  for (const [name, run] of surfaces) {
    try {
      await run();
    } catch (err) {
      console.error(`[demo-data] seeding ${name} failed`, err);
    }
  }

  const db = await getDb();
  // Contacts exist now, so `needsOnboarding` is already false; stamping it as well keeps
  // every other first-run surface from treating a full demo account as brand new.
  await db
    .update(userSettings)
    .set({ onboardingCompletedAt: new Date(now) })
    .where(and(eq(userSettings.userId, userId), isNull(userSettings.onboardingCompletedAt)));
  // Seeded contacts carry no closeness scores; the next read recalibrates the network.
  await markCohortDirty(userId).catch(() => null);

  return summary;
}

/* ------------------------------------------------------------------------------ network */

async function seedNetwork(
  userId: string,
  ago: (d: number) => Date,
  ahead: (d: number) => Date,
  summary: DemoSeedSummary
): Promise<Map<string, string>> {
  const db = await getDb();

  const resolver = await createCompanyResolver(userId);
  await resolver.prime(DEMO_PEOPLE.map((p) => p.company ?? null));

  const ids = new Map(DEMO_PEOPLE.map((p) => [p.fullName, randomUUID()]));
  const rows: NewContact[] = [];
  for (const p of DEMO_PEOPLE) {
    const touches = p.touches ?? [];
    // Interaction stamps come only from real touches — the app distinguishes "we spoke"
    // from "you added them", and seeded data must not blur that.
    const days = touches.map((t) => t.at);
    const company = p.company ? await resolver(p.company) : null;
    rows.push({
      id: ids.get(p.fullName)!,
      userId,
      fullName: p.fullName,
      firstName: p.firstName,
      lastName: p.lastName,
      title: p.title,
      company: p.company ?? null,
      companyId: company?.id ?? null,
      school: p.school ?? null,
      location: p.location ?? null,
      email: p.email ?? null,
      linkedinUrl: p.linkedinUrl ?? null,
      relationshipScore: p.closeness,
      statedCloseness: p.closeness,
      priorityLevel: p.priority ?? 0,
      source: DEMO_SOURCE,
      howMet: p.howMet,
      metContext: p.metContext ?? null,
      dateMet: ago(p.metDaysAgo),
      notes: p.notes ?? null,
      keyFacts: p.keyFacts ?? [],
      sharedInterests: p.sharedInterests ?? [],
      aiSummary: summaryFor(p),
      firstInteractionAt: days.length ? ago(Math.max(...days)) : null,
      lastInteractionAt: days.length ? ago(Math.min(...days)) : null,
      nextFollowUpAt: p.followUpInDays == null ? null : ahead(p.followUpInDays),
      followUpStatus: p.followUpInDays == null ? "none" : "pending",
      // Flags the rows for the embedding backfill, so chat's semantic arm picks them up
      // wherever an embedding provider is configured.
      embeddingStaleAt: new Date(),
    });
  }
  await db.insert(contacts).values(rows);
  summary.contacts = rows.length;

  const identityRows = DEMO_PEOPLE.flatMap((p) =>
    identityKeysFor({ email: p.email, linkedinUrl: p.linkedinUrl }).map((k) => ({
      userId,
      contactId: ids.get(p.fullName)!,
      kind: k.kind,
      value: k.value,
      source: DEMO_SOURCE,
    }))
  );
  if (identityRows.length) {
    await db.insert(contactIdentities).values(identityRows).onConflictDoNothing();
  }

  // Timelines. Ids are minted here so action items and briefs can point at their
  // interaction without relying on RETURNING order.
  const interactionRows: (typeof interactions.$inferInsert)[] = [];
  const itemRows: (typeof actionItems.$inferInsert)[] = [];
  const briefRows: (typeof contactBriefs.$inferInsert)[] = [];
  for (const p of DEMO_PEOPLE) {
    const contactId = ids.get(p.fullName)!;
    const mine: { id: string; interactionDate: Date; interactionType: string; aiSummary: null; rawNotes: string }[] = [];
    for (const t of p.touches ?? []) {
      const id = randomUUID();
      const interactionDate = ago(t.at);
      interactionRows.push({
        id,
        userId,
        contactId,
        interactionType: t.type,
        interactionDate,
        source: DEMO_SOURCE,
        rawNotes: t.notes,
        topics: t.topics ?? [],
        actionItems: t.actionItems ?? [],
        direction: t.type === "linkedin_message" ? t.direction ?? null : null,
      });
      mine.push({ id, interactionDate, interactionType: t.type, aiSummary: null, rawNotes: t.notes });
      (t.actionItems ?? []).forEach((text, position) => {
        itemRows.push({
          userId,
          contactId,
          interactionId: id,
          text,
          position,
          itemHash: actionItemHash(id, text),
        });
      });
    }
    const recent = buildRecentDiscussions(mine);
    briefRows.push({
      contactId,
      userId,
      standing: p.standing,
      recentDiscussions: recent,
      basisInteractionId: recent[0]?.interactionId ?? null,
      model: DEMO_SOURCE,
    });
  }
  if (interactionRows.length) await db.insert(interactions).values(interactionRows);
  if (itemRows.length) await db.insert(actionItems).values(itemRows);
  if (briefRows.length) await db.insert(contactBriefs).values(briefRows);
  summary.interactions = interactionRows.length;
  summary.actionItems = itemRows.length;

  // Work history and profiles, so the profile timeline has roles and schools.
  const experienceRows: (typeof contactExperiences.$inferInsert)[] = [];
  const profileRows: (typeof contactProfiles.$inferInsert)[] = [];
  for (const p of DEMO_PEOPLE) {
    const contactId = ids.get(p.fullName)!;
    let sortIndex = 0;
    for (const [organization, title, startYear, endYear] of p.history ?? []) {
      experienceRows.push({
        userId,
        contactId,
        kind: "role",
        organization,
        organizationNormalized: normalizeCompanyKey(organization),
        title,
        startYear,
        endYear,
        isCurrent: endYear === null,
        sortIndex: sortIndex++,
        source: "apollo",
      });
    }
    for (const [organization, fieldOfStudy, startYear, endYear] of p.education ?? []) {
      experienceRows.push({
        userId,
        contactId,
        kind: "education",
        organization,
        organizationNormalized: normalizeCompanyKey(organization),
        fieldOfStudy,
        startYear,
        endYear,
        sortIndex: sortIndex++,
        source: "apollo",
      });
    }
    profileRows.push({
      userId,
      contactId,
      headline: p.company ? `${p.title} at ${p.company}` : p.title,
      about: p.notes ?? null,
      skills: [...(p.sharedInterests ?? []), ...(p.tags ?? [])].map((name) => ({ name })),
      source: "apollo",
      sourceUrl: p.linkedinUrl ?? null,
    });
  }
  if (experienceRows.length) await db.insert(contactExperiences).values(experienceRows);
  if (profileRows.length) await db.insert(contactProfiles).values(profileRows);
  summary.experiences = experienceRows.length;

  const tagNames = [...new Set(DEMO_PEOPLE.flatMap((p) => p.tags ?? []))].sort();
  if (tagNames.length) {
    const insertedTags = await db
      .insert(tags)
      .values(tagNames.map((name) => ({ userId, name })))
      .returning();
    const tagIdByName = new Map(insertedTags.map((t) => [t.name, t.id]));
    const links = DEMO_PEOPLE.flatMap((p) =>
      (p.tags ?? []).map((name) => ({
        contactId: ids.get(p.fullName)!,
        tagId: tagIdByName.get(name)!,
      }))
    );
    if (links.length) await db.insert(contactTags).values(links);
    summary.tags = insertedTags.length;
  }

  return ids;
}

function summaryFor(p: DemoPerson) {
  const role = p.company ? `${p.title} at ${p.company}` : p.title;
  return `${p.fullName} is ${role}. How you met: ${p.howMet}. ${p.notes ?? ""}`.trim();
}

/* ---------------------------------------------------------------------------- reminders */

async function seedReminders(
  userId: string,
  contactIdByName: Map<string, string>,
  ahead: (d: number) => Date,
  summary: DemoSeedSummary
) {
  const db = await getDb();
  const inboxId = await getInboxListId(userId);
  const [fundraising] = await db
    .insert(reminderLists)
    .values({ userId, name: "Fundraising", nameNormalized: "fundraising", position: 1 })
    .onConflictDoNothing()
    .returning();
  const listFor = (name?: string) => (name === "Fundraising" && fundraising ? fundraising.id : inboxId);

  const rows: (typeof reminders.$inferInsert)[] = DEMO_PEOPLE.flatMap((p) =>
    p.reminder
      ? [
          {
            userId,
            contactId: contactIdByName.get(p.fullName)!,
            listId: listFor(p.reminder.list),
            title: p.reminder.title,
            description: p.reminder.description ?? null,
            dueDate: ahead(p.reminder.inDays),
            actionKind: "follow_up" as const,
          },
        ]
      : []
  );
  rows.push(
    {
      userId,
      listId: listFor("Fundraising"),
      title: "Draft the October investor update",
      description: "Traction, the Codex partnership conversation, and the founding-engineer search.",
      dueDate: ahead(3),
      actionKind: "task",
    },
    {
      userId,
      listId: inboxId,
      title: "Book a venue for the Orbit user dinner",
      dueDate: ahead(10),
      actionKind: "task",
    },
    {
      userId,
      contactId: contactIdByName.get("Tom Bennett"),
      listId: inboxId,
      title: "Call Tom about API versioning",
      description: "He offered to review the public API design.",
      dueDate: ahead(6),
      actionKind: "call",
    },
    {
      userId,
      contactId: contactIdByName.get("Nina Petrova"),
      listId: inboxId,
      title: "Thank Nina for the positioning feedback",
      dueDate: ahead(-9),
      status: "done",
      actionKind: "email",
    }
  );
  await db.insert(reminders).values(rows);
  summary.reminders = rows.length;

  // One capture awaiting review, so the "from your notes" queue is not empty.
  const captureBatchId = randomUUID();
  const source = "Dinner with Nina and Daniel. Promised Nina the pricing draft, and Daniel wants the hiring scorecard.";
  const sourceHash = sha256(source);
  const pending = [
    { contact: "Nina Petrova", title: "Send Nina the pricing draft", inDays: 4, excerpt: "Promised Nina the pricing draft" },
    { contact: "Daniel Osei", title: "Send Daniel the hiring scorecard", inDays: 8, excerpt: "Daniel wants the hiring scorecard" },
  ];
  await db.insert(suggestedReminders).values(
    pending.map((s) => {
      const due = ahead(s.inDays);
      return {
        userId,
        contactId: contactIdByName.get(s.contact) ?? null,
        captureBatchId,
        title: s.title,
        rawDatePhrase: due.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        dueDate: due,
        sourceExcerpt: s.excerpt,
        sourceHash,
        itemHash: sha256(`${sourceHash}|${due.toISOString().slice(0, 10)}|${s.title.toLowerCase()}`),
        actionKind: "email" as const,
        confidenceScore: 88,
      };
    })
  );
  summary.suggestedReminders = pending.length;
}

/* ----------------------------------------------------------------------------- outreach */

type DemoProspect = {
  name: string;
  title: string;
  company: string;
  email?: string;
  location?: string;
  /** Link to an existing demo contact of the same name. */
  contact?: boolean;
  status: string;
  messages?: Array<{
    subject: string;
    body: string;
    status: string;
    stepIndex?: number;
    sentDaysAgo?: number;
    outcome?: string;
    repliedDaysAgo?: number;
    outcomeNotes?: string;
  }>;
};

async function seedOutreach(
  userId: string,
  contactIdByName: Map<string, string>,
  ago: (d: number) => Date,
  summary: DemoSeedSummary
) {
  const db = await getDb();
  const campaigns: Array<{
    values: Omit<typeof outreachCampaigns.$inferInsert, "userId">;
    prospects: DemoProspect[];
  }> = [
    {
      values: {
        name: "AI lab partnerships",
        status: "active",
        audienceQuery: "Partnerships and developer-relations leads at AI labs",
        audienceFilters: { titles: ["Partnerships", "Developer Relations"], industries: ["Artificial Intelligence"] },
        messageIntent: "Explore a developer-tools integration between Orbit and their platform",
        replyCta: "book_intro",
        tone: "friendly",
        defaultChannel: "email",
        sequenceSteps: [{ delayDays: 0 }, { delayDays: 4, intent: "Short, friendly bump" }],
        lastSearchSource: "demo",
        createdAt: ago(30),
        updatedAt: ago(2),
      },
      prospects: [
        {
          name: "David Kim",
          title: "Engineering Manager",
          company: "OpenAI",
          contact: true,
          status: "interested",
          messages: [
            {
              subject: "Evaluation infra — following up on Sarah's intro",
              body: "Hi David — Sarah suggested we talk about evaluation infrastructure. Orbit runs a retrieval eval harness over personal networks and I'd love your read on it. Would 20 minutes next week work?",
              status: "sent",
              sentDaysAgo: 26,
              outcome: "positive_reply",
              repliedDaysAgo: 24,
              outcomeNotes: "Happy to talk after their planning cycle. Suggested early next month.",
            },
          ],
        },
        {
          name: "Yuki Tanaka",
          title: "Research Scientist",
          company: "Anthropic",
          contact: true,
          status: "replied",
          messages: [
            {
              subject: "Retrieval evals for relationship data",
              body: "Hi Yuki — your papers shaped how Orbit evaluates retrieval. Would you be open to a short look at what we built?",
              status: "sent",
              sentDaysAgo: 25,
              outcome: "neutral_reply",
              repliedDaysAgo: 22,
              outcomeNotes: "Busy until the end of the quarter, but interested later.",
            },
          ],
        },
        {
          name: "Jordan Hale",
          title: "Head of Developer Relations",
          company: "Cohere",
          email: "jordan.hale@example.com",
          location: "Toronto, Canada",
          status: "contacted",
          messages: [
            {
              subject: "Orbit × Cohere — a developer-tools idea",
              body: "Hi Jordan — Orbit helps developers keep track of the people behind their integrations. I think there's a neat Cohere tie-in. Open to a quick intro call?",
              status: "sent",
              sentDaysAgo: 6,
            },
            // A follow-up ready to send, counted as "follow-up due". Deliberately `generated`
            // rather than `scheduled`: a scheduled row whose time has passed is exactly what
            // the outreach sender and the ops sweep pick up, and demo data must never send.
            {
              subject: "Re: Orbit × Cohere — a developer-tools idea",
              body: "Hi Jordan — just floating this back up. Happy to send a two-minute demo instead of a call if that's easier.",
              status: "generated",
              stepIndex: 1,
            },
          ],
        },
        {
          name: "Lena Park",
          title: "Partnerships Manager",
          company: "Mistral AI",
          email: "lena.park@example.com",
          location: "Paris, France",
          status: "contacted",
          messages: [
            {
              subject: "A partnership idea from Orbit",
              body: "Hi Lena — I'm building Orbit, a relationship CRM for developers. Would you be the right person to talk to about ecosystem partnerships?",
              status: "sent",
              sentDaysAgo: 20,
              outcome: "bounced",
            },
          ],
        },
        {
          name: "Omar Haddad",
          title: "Developer Advocate",
          company: "Hugging Face",
          email: "omar.haddad@example.com",
          location: "New York, NY",
          status: "selected",
          messages: [
            {
              subject: "Orbit + the Hugging Face community",
              body: "Hi Omar — your community work is the reason I started thinking about Orbit for open-source maintainers. Would you be up for a 15-minute chat about what maintainers actually need?",
              status: "generated",
            },
          ],
        },
        {
          name: "Chloe Martin",
          title: "Ecosystem Lead",
          company: "Perplexity",
          location: "San Francisco, CA",
          status: "suggested",
        },
      ],
    },
    {
      values: {
        name: "Triangle seed investors",
        status: "draft",
        audienceQuery: "Seed investors and angels in the Research Triangle who back developer tools",
        audienceFilters: { titles: ["Partner", "Angel Investor", "Principal"], locations: ["Durham, NC", "Raleigh, NC", "Chapel Hill, NC"] },
        messageIntent: "Share the monthly update and ask to be considered for the pre-seed round",
        replyCta: "book_intro",
        tone: "professional",
        defaultChannel: "email",
        sequenceSteps: [{ delayDays: 0 }],
        lastSearchSource: "demo",
        createdAt: ago(5),
        updatedAt: ago(1),
      },
      prospects: [
        {
          name: "Grace Whitfield",
          title: "Angel Investor",
          company: "Independent",
          contact: true,
          status: "selected",
          messages: [
            {
              subject: "Orbit — Q3 update",
              body: "Hi Grace — here's the short quarterly update you asked for: usage is up 3x since July, and we're opening a small pre-seed round. Would you like the details?",
              status: "generated",
            },
          ],
        },
        { name: "Reid Calloway", title: "Partner", company: "Triangle Angel Partners", location: "Raleigh, NC", status: "suggested" },
        { name: "Sam Ortiz", title: "Principal", company: "IDEA Fund Partners", location: "Durham, NC", status: "suggested" },
      ],
    },
  ];

  let prospectCount = 0;
  let messageCount = 0;
  for (const c of campaigns) {
    const [campaign] = await db
      .insert(outreachCampaigns)
      .values({ ...c.values, userId })
      .returning();
    for (const [i, p] of c.prospects.entries()) {
      const prospectId = randomUUID();
      await db.insert(outreachProspects).values({
        id: prospectId,
        campaignId: campaign.id,
        externalId: `demo:${i}:${normalizePersonName(p.name)}`,
        contactId: p.contact ? contactIdByName.get(p.name) ?? null : null,
        fullName: p.name,
        title: p.title,
        company: p.company,
        email: p.email ?? null,
        location: p.location ?? null,
        status: p.status,
        createdAt: c.values.createdAt,
      });
      prospectCount += 1;
      if (p.messages?.length) {
        await db.insert(outreachMessages).values(
          p.messages.map((m) => ({
            prospectId,
            channel: "email",
            subject: m.subject,
            body: m.body,
            status: m.status,
            stepIndex: m.stepIndex ?? 0,
            sentAt: m.sentDaysAgo == null ? null : ago(m.sentDaysAgo),
            outcome: m.outcome ?? null,
            outcomeNotes: m.outcomeNotes ?? null,
            repliedAt: m.repliedDaysAgo == null ? null : ago(m.repliedDaysAgo),
            lastActionAt: m.repliedDaysAgo != null ? ago(m.repliedDaysAgo) : m.sentDaysAgo != null ? ago(m.sentDaysAgo) : null,
          }))
        );
        messageCount += p.messages.length;
      }
    }
  }
  summary.campaigns = campaigns.length;
  summary.prospects = prospectCount;
  summary.outreachMessages = messageCount;
}

/* --------------------------------------------------------------------------- recruiters */

async function seedRecruiters(
  userId: string,
  contactIdByName: Map<string, string>,
  ago: (d: number) => Date,
  summary: DemoSeedSummary
) {
  const db = await getDb();
  const cast = [
    {
      fullName: "Alex Rivera",
      firm: "Rivera Talent",
      specialty: ["Engineering", "AI"],
      email: "alex@riveratalent.example",
      linkedinUrl: "https://www.linkedin.com/in/alex-rivera-talent",
      link: {
        status: "active" as const,
        personalRating: 5,
        notes: "Great for senior eng roles. Honest about comp bands.",
        aiSummary:
          "Six emails over three months. Alex has sent two founding-engineer roles at seed-stage AI startups and a staff role at Ramp; the most recent thread is about a January start.",
        companiesMentioned: ["Ramp", "Glean", "Harvey"],
        rolesDiscussed: ["Founding Engineer", "Staff Software Engineer"],
        firstEmailAt: ago(95),
        lastEmailAt: ago(9),
        emailCount: 6,
      },
      message: {
        intent: "upcoming_drops" as const,
        subject: "Anything opening up in January?",
        body: "Hi Alex — thanks again for the Ramp intro. Are you expecting any founding-engineer roles to open up in January? Happy to hop on a call.",
        status: "sent" as const,
        sentAt: ago(9),
      },
    },
    {
      fullName: "Morgan Blake",
      firm: "Insight Global",
      specialty: ["Product", "Design"],
      email: "morgan.blake@insightglobal.example",
      linkedinUrl: null,
      link: {
        status: "contacted" as const,
        personalRating: 3,
        notes: "Mostly contract roles. Responsive.",
        aiSummary: "Two emails about contract product roles in Raleigh. No roles shared since the first exchange.",
        companiesMentioned: ["Red Hat", "SAS"],
        rolesDiscussed: ["Product Manager (contract)"],
        firstEmailAt: ago(40),
        lastEmailAt: ago(33),
        emailCount: 2,
      },
      message: {
        intent: "set_up_chat" as const,
        subject: "Quick chat about product roles?",
        body: "Hi Morgan — I'd love 15 minutes to hear what product roles you're seeing in the Triangle this fall. Does Thursday work?",
        status: "draft" as const,
        sentAt: null,
      },
    },
    {
      fullName: "Marcus Lee",
      firm: "Stripe",
      specialty: ["Payments", "Infrastructure"],
      email: "marcus.lee@example.com",
      linkedinUrl: null,
      contact: "Marcus Lee",
      link: {
        status: "planned" as const,
        personalRating: 4,
        notes: "In-house at Stripe. Check back before the January cycle.",
        aiSummary: null,
        companiesMentioned: ["Stripe"],
        rolesDiscussed: ["Payments Infrastructure Engineer"],
        firstEmailAt: ago(90),
        lastEmailAt: ago(34),
        emailCount: 3,
      },
      message: null,
    },
  ];

  for (const r of cast) {
    // Recruiter profiles are a shared, cross-user pool: reuse an existing row rather than
    // minting a duplicate each time another local account is seeded.
    const emailNormalized = normalizeEmail(r.email);
    let recruiter = emailNormalized
      ? await db.query.recruiters.findFirst({ where: eq(recruiters.emailNormalized, emailNormalized) })
      : undefined;
    if (!recruiter) {
      [recruiter] = await db
        .insert(recruiters)
        .values({
          fullName: r.fullName,
          nameNormalized: normalizePersonName(r.fullName),
          firm: r.firm,
          firmNormalized: normalizeFirm(r.firm),
          specialty: r.specialty,
          email: r.email,
          emailNormalized,
          linkedinUrl: r.linkedinUrl,
        })
        .returning();
    }
    await db
      .insert(userRecruiterLinks)
      .values({
        userId,
        recruiterId: recruiter.id,
        source: "manual",
        contactId: "contact" in r && r.contact ? contactIdByName.get(r.contact) ?? null : null,
        ...r.link,
      })
      .onConflictDoNothing();
    if (r.message) {
      await db.insert(recruiterMessages).values({ userId, recruiterId: recruiter.id, ...r.message });
    }
    await recomputeRecruiterRating(recruiter.id).catch(() => null);
  }
  summary.recruiters = cast.length;
}

/* ------------------------------------------------------------------------------- events */

async function seedEvents(
  userId: string,
  contactIdByName: Map<string, string>,
  ago: (d: number) => Date,
  ahead: (d: number) => Date,
  summary: DemoSeedSummary
) {
  const db = await getDb();
  type Attendee = { name: string; company?: string; title?: string; role?: "attendee" | "host" | "speaker"; contact?: boolean };
  const cast: Array<{
    values: Omit<typeof events.$inferInsert, "userId">;
    attendees: Attendee[];
  }> = [
    {
      values: {
        title: "Innovate Carolina Fall Showcase",
        startsAt: ahead(12),
        endsAt: new Date(ahead(12).getTime() + 3 * 3600_000),
        venue: "Genome Sciences Building",
        city: "Chapel Hill, NC",
        description: "Presenting Orbit to Triangle founders and investors.",
        attendeeCount: 180,
        notes: "Five-minute demo slot. Bring the one-liner Maya asked for.",
      },
      attendees: [
        { name: "Maya Thompson", company: "Innovate Carolina", title: "Program Director", role: "host", contact: true },
        { name: "Grace Whitfield", company: "Independent", title: "Angel Investor", contact: true },
        { name: "Priyanka Rao", company: "Duke Capital Partners", title: "Associate" },
      ],
    },
    {
      values: {
        title: "AWS Summit 2026",
        startsAt: ago(61),
        endsAt: new Date(ago(61).getTime() + 9 * 3600_000),
        venue: "Moscone Center",
        city: "San Francisco, CA",
        description: "Inference keynote, then the hallway track.",
        attendeeCount: 4000,
        notes: "Best conversations were after the inference keynote.",
      },
      attendees: [
        { name: "Sarah Chen", company: "OpenAI", title: "Partnerships Lead", contact: true },
        { name: "Priya Nair", company: "Notion", title: "Founding Engineer", contact: true },
        { name: "Kenji Watanabe", company: "Amazon Web Services", title: "Principal Solutions Architect", role: "speaker" },
        { name: "Laura Mendes", company: "Fieldnote", title: "CTO" },
      ],
    },
    {
      values: {
        title: "UNC Founders Dinner",
        startsAt: ago(75),
        venue: "The Carolina Inn",
        city: "Chapel Hill, NC",
        attendeeCount: 40,
        notes: "Elena introduced me to James here.",
      },
      attendees: [
        { name: "Dr. Elena Vasquez", company: "UNC Chapel Hill", title: "Professor of Computer Science", contact: true },
        { name: "James Okafor", company: "Bellwether Ventures", title: "Partner", contact: true },
        { name: "Tyler Grant", company: "Rootline", title: "Founder" },
      ],
    },
    {
      values: {
        title: "HackNC 2026",
        startsAt: ago(45),
        venue: "Sitterson Hall",
        city: "Chapel Hill, NC",
        description: "Judged the AI track.",
        attendeeCount: 600,
      },
      attendees: [
        { name: "Ben Carter", company: "UNC Chapel Hill", title: "Computer Science Student", contact: true },
        { name: "Maria Lopez", company: "UNC Chapel Hill", title: "Student Organizer", role: "host" },
      ],
    },
  ];

  let attendeeCount = 0;
  for (const e of cast) {
    const [event] = await db
      .insert(events)
      .values({
        ...e.values,
        userId,
        role: "attended",
        source: "manual",
        timezone: "America/New_York",
        // Marks the row as already enriched so nothing tries to fetch a page for it.
        enrichedAt: new Date(),
      })
      .returning();
    const rows = e.attendees.map((a) => {
      const contactId = a.contact ? contactIdByName.get(a.name) ?? null : null;
      return {
        eventId: event.id,
        userId,
        fullName: a.name,
        company: a.company ?? null,
        title: a.title ?? null,
        attendeeRole: a.role ?? "attendee",
        source: "paste" as const,
        spokeTo: contactId ? 1 : 0,
        contactId,
        convertedAt: contactId ? new Date() : null,
        identityKey: `nm:${a.name.trim().toLowerCase().replace(/\s+/g, " ")}`,
      };
    });
    await db.insert(eventAttendees).values(rows);
    attendeeCount += rows.length;
  }
  summary.events = cast.length;
  summary.eventAttendees = attendeeCount;
}

/* --------------------------------------------------------------------------------- chat */

async function seedChat(
  userId: string,
  contactIdByName: Map<string, string>,
  ago: (d: number) => Date,
  summary: DemoSeedSummary
) {
  const db = await getDb();
  const rec = (name: string, reason: string, action: string, draft: string | null): ChatRecommendation => ({
    contact_id: contactIdByName.get(name) ?? null,
    name,
    reason,
    suggested_action: action,
    draft_message: draft,
  });
  const threads: Array<{ title: string; daysAgo: number; question: string; answer: string; recommendations: ChatRecommendation[] }> = [
    {
      title: "Who can help with the Codex partnership?",
      daysAgo: 3,
      question: "Who in my network can help me land the Codex partnership?",
      answer:
        "Sarah Chen is the clear first move — she leads Codex partnerships and is already waiting on your one-page architecture. David Kim, whom she introduced, owns the evaluation infrastructure the integration would touch. Victor Reyes at Anthropic reviewed your prompting and could sanity-check the write-up before you send it.",
      recommendations: [
        rec("Sarah Chen", "Leads Codex partnerships and asked for the write-up.", "Send the one-page architecture", "Hi Sarah — here's the one-pager on Orbit's retrieval architecture, plus a 3-minute demo. Happy to walk your team through it."),
        rec("David Kim", "Owns the evaluation infrastructure; asked to be pinged after a few weeks.", "Book a 20-minute call", null),
        rec("Victor Reyes", "Reviewed Orbit's prompting recently.", "Ask for a quick review of the write-up", null),
      ],
    },
    {
      title: "Investors to update this week",
      daysAgo: 1,
      question: "Which investors should I update this week?",
      answer:
        "Two are overdue: James Okafor asked for your monthly update at the UNC founders dinner, and Grace Whitfield expects a quarterly note and decides fast. Amara Diallo at Bellwether is worth a mention too — she shares a candidate list with portfolio founders, which helps the founding-engineer search.",
      recommendations: [
        rec("James Okafor", "Asked to be on the monthly update list; 4 days overdue.", "Send the monthly update", null),
        rec("Grace Whitfield", "Wants a short quarterly update; a week overdue.", "Send the Q3 update", "Hi Grace — quick quarterly update: usage is up 3x since July and we're opening a small pre-seed round."),
      ],
    },
  ];

  for (const t of threads) {
    const at = ago(t.daysAgo);
    const [thread] = await db
      .insert(chatThreads)
      .values({ userId, title: t.title, createdAt: at, updatedAt: at })
      .returning();
    await db.insert(chatMessages).values([
      { threadId: thread.id, userId, role: "user", content: t.question, createdAt: at },
      {
        threadId: thread.id,
        userId,
        role: "assistant",
        content: t.answer,
        recommendations: t.recommendations,
        createdAt: new Date(at.getTime() + 8000),
      },
    ]);
  }
  summary.chatThreads = threads.length;
}

/* ---------------------------------------------------------------------- imports + goals */

async function seedImports(userId: string, ago: (d: number) => Date, summary: DemoSeedSummary) {
  const db = await getDb();
  await db.insert(imports).values({
    userId,
    importType: "linkedin_connections",
    fileName: "Connections.csv",
    status: "completed",
    totalRows: DEMO_PEOPLE.length,
    rowsProcessed: DEMO_PEOPLE.length,
    contactsCreated: DEMO_PEOPLE.length - 6,
    contactsUpdated: 6,
    duplicatesFound: 2,
    stats: { skipped: 0 },
    createdAt: ago(120),
    updatedAt: ago(120),
  });
  summary.imports = 1;
}

async function seedGoals(userId: string, summary: DemoSeedSummary) {
  const db = await getDb();
  await db.insert(userGoals).values(DEMO_GOALS.map((text) => ({ userId, text })));
  summary.goals = DEMO_GOALS.length;
}

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
