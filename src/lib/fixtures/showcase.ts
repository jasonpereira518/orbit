import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  aiSuggestions,
  contactTags,
  contacts,
  interactions,
  reminders,
  suggestedReminders,
  tags,
} from "@/db/schema";
import type { NewContact } from "@/db/schema";

/**
 * The showcase network — a small, hand-written dataset built to exercise Orbit end to end.
 *
 * Unlike `scripts/seed-graph-fixture.ts` (114 procedurally generated people, for stressing
 * the constellation layout), this is ~24 people with real texture: notes worth reading,
 * logged interactions so closeness and timelines are earned rather than implied, repeated
 * companies so clustering and "who do I know at X?" both work, a UNC cohort, and a
 * deliberate spread of overdue / upcoming / healthy follow-ups.
 *
 * It lives under `src/lib` rather than in `scripts/` because two callers need it: the CLI
 * seeder and the testing console's reseed button. Every date is stored as a day offset
 * rather than a `Date`, so the data itself is a constant and `seedShowcase` resolves the
 * offsets against the clock at the moment it runs — a fixture that is always "recently
 * active" no matter when it is loaded.
 */

const DAY = 86_400_000;

export type Touch = {
  /** Days ago. */
  at: number;
  type: "note" | "meeting" | "email" | "call" | "message";
  notes: string;
  topics?: string[];
};

export type Person = {
  fullName: string;
  firstName: string;
  lastName: string;
  title: string;
  company?: string;
  school?: string;
  location?: string;
  email?: string;
  linkedinUrl?: string;
  /** 1–5, what the user would say if asked. */
  closeness: number;
  priority?: number;
  howMet: string;
  metContext?: string;
  /** Days ago. */
  metDaysAgo: number;
  notes?: string;
  keyFacts?: string[];
  sharedInterests?: string[];
  tags?: string[];
  touches?: Touch[];
  /** Days: negative = overdue, positive = upcoming, undefined = no follow-up set. */
  followUpInDays?: number;
  /** A reminder row, so the Reminders page and the bell are not empty. */
  reminder?: { title: string; description?: string; inDays: number };
};

/**
 * The cast. Companies repeat on purpose (OpenAI x3, Stripe x3, Google x3, UNC x4) so the
 * constellation forms real clusters and the roster answer to "who do I know at X?" is
 * more than one person.
 */
export const SHOWCASE_PEOPLE: Person[] = [
  {
    fullName: "Sarah Chen",
    firstName: "Sarah",
    lastName: "Chen",
    title: "Partnerships Lead",
    company: "OpenAI",
    location: "San Francisco, CA",
    email: "sarah.chen@example.com",
    linkedinUrl: "https://www.linkedin.com/in/sarah-chen-demo",
    closeness: 4,
    priority: 2,
    howMet: "AWS Summit — hallway track after the inference keynote",
    metContext: "AWS Summit 2026",
    metDaysAgo: 61,
    notes:
      "Runs partnerships for the Codex team. Spent most of our conversation on the cost of inference at scale and why most startups over-provision GPUs. Offered to look at Orbit's retrieval setup if I send her a write-up. Prefers email over LinkedIn.",
    keyFacts: [
      "Leads Codex partnerships at OpenAI",
      "Was previously infra PM at Stripe",
      "Asked for a one-pager on Orbit's retrieval architecture",
    ],
    sharedInterests: ["AI infrastructure", "developer tools"],
    tags: ["AI", "Warm intro"],
    touches: [
      {
        at: 61,
        type: "meeting",
        notes:
          "Met at the AWS Summit after the inference keynote. Talked through AI infrastructure costs — she thinks most teams over-provision by 3-4x. Mentioned the Codex partnerships team is looking at developer-tool integrations.",
        topics: ["AI infrastructure", "AWS Summit"],
      },
      {
        at: 43,
        type: "email",
        notes:
          "Sent the follow-up she asked for. She replied same day, said she'd share it with her team and to ping her after their planning cycle.",
        topics: ["Codex", "partnerships"],
      },
    ],
    followUpInDays: -12,
    reminder: {
      title: "Send Sarah the retrieval write-up",
      description: "She asked for a one-pager after the AWS Summit conversation.",
      inDays: -12,
    },
  },
  {
    fullName: "Marcus Lee",
    firstName: "Marcus",
    lastName: "Lee",
    title: "Technical Recruiter",
    company: "Stripe",
    location: "New York, NY",
    email: "marcus.lee@example.com",
    closeness: 3,
    howMet: "Reached out on LinkedIn about the payments infra team",
    metDaysAgo: 90,
    notes:
      "Recruits for Stripe's payments infrastructure org. Straightforward, does not spam. Said the team hires in January and July and to check back before the January cycle.",
    keyFacts: ["Hires for Stripe payments infra", "Cycles are January and July"],
    tags: ["Hiring"],
    touches: [
      {
        at: 90,
        type: "message",
        notes:
          "First LinkedIn message about the payments infra team. Asked for my resume and what I'm optimising for.",
      },
      {
        at: 34,
        type: "call",
        notes:
          "Twenty-minute intro call. He was honest that headcount is frozen until January. Offered to make an intro to the platform team lead in the meantime.",
        topics: ["hiring", "Stripe"],
      },
    ],
    followUpInDays: 9,
  },
  {
    fullName: "Priya Nair",
    firstName: "Priya",
    lastName: "Nair",
    title: "Founding Engineer",
    company: "Notion",
    location: "Remote",
    closeness: 4,
    howMet: "AWS Summit — same afterparty as Sarah",
    metContext: "AWS Summit 2026",
    metDaysAgo: 61,
    notes:
      "Building agent workflows inside Notion. We compared notes on evaluation harnesses — she has a homegrown one she said she'd write about. Very generous with time.",
    keyFacts: ["Works on agent workflows", "Writing a post on eval harnesses"],
    sharedInterests: ["agents", "evals"],
    tags: ["AI"],
    touches: [
      {
        at: 61,
        type: "meeting",
        notes:
          "Met at the AWS Summit afterparty through Sarah. Long conversation about agent evaluation — she runs a homegrown harness and offered to share the design.",
        topics: ["agents", "evals", "AWS Summit"],
      },
      {
        at: 21,
        type: "message",
        notes: "Swapped links about eval tooling. She's still planning to write the post.",
      },
    ],
    followUpInDays: 21,
  },
  {
    fullName: "Dr. Elena Vasquez",
    firstName: "Elena",
    lastName: "Vasquez",
    title: "Professor of Computer Science",
    school: "UNC Chapel Hill",
    company: "UNC Chapel Hill",
    location: "Chapel Hill, NC",
    closeness: 4,
    priority: 2,
    howMet: "Taught my systems course; kept in touch after graduation",
    metDaysAgo: 400,
    notes:
      "Runs the distributed systems lab. Always worth talking to before a design decision. Suggested two students who might want to intern.",
    keyFacts: ["Runs the distributed systems lab at UNC", "Knows the Innovate Carolina staff"],
    tags: ["UNC", "Mentor"],
    touches: [
      {
        at: 120,
        type: "meeting",
        notes:
          "Coffee on campus. Walked her through Orbit's data model; she pushed back on storing derived scores and was right.",
        topics: ["architecture", "UNC"],
      },
      {
        at: 18,
        type: "email",
        notes:
          "She sent two student names for a possible internship and asked how the showcase prep is going.",
        topics: ["UNC", "hiring"],
      },
    ],
    followUpInDays: 5,
    reminder: {
      title: "Reply to Elena about the two students",
      description: "She sent names for a possible internship.",
      inDays: 2,
    },
  },
  {
    fullName: "James Okafor",
    firstName: "James",
    lastName: "Okafor",
    title: "Partner",
    company: "Bellwether Ventures",
    location: "New York, NY",
    closeness: 3,
    priority: 2,
    howMet: "Introduced by Elena at the UNC founders dinner",
    metContext: "UNC founders dinner",
    metDaysAgo: 75,
    notes:
      "Seed-stage, writes $500k–$1.5M checks, spends most of his time on developer tools. Said he does not take cold decks but always reads a monthly update. Asked to be added to mine.",
    keyFacts: [
      "Seed investor, $500k–$1.5M checks",
      "Wants to be on the monthly update list",
      "Does not read cold decks",
    ],
    tags: ["Investor", "UNC"],
    touches: [
      {
        at: 75,
        type: "meeting",
        notes:
          "Met at the UNC founders dinner. Asked good questions about retention rather than growth. Wants the monthly update, not a deck.",
        topics: ["fundraising", "UNC"],
      },
    ],
    followUpInDays: -4,
    reminder: {
      title: "Add James to the monthly update",
      description: "He asked to be on the list at the UNC founders dinner.",
      inDays: -4,
    },
  },
  {
    fullName: "Aisha Rahman",
    firstName: "Aisha",
    lastName: "Rahman",
    title: "Senior Product Manager",
    company: "Google",
    location: "Seattle, WA",
    closeness: 3,
    howMet: "Former teammate at my first job",
    metDaysAgo: 900,
    notes:
      "Worked together on the billing team. Now on Google Cloud's developer experience org. Reliable sounding board for anything pricing-related.",
    keyFacts: ["Former teammate", "Now on Google Cloud DevEx"],
    tags: ["Former coworker"],
    touches: [
      {
        at: 210,
        type: "call",
        notes: "Catch-up call. She walked me through how Cloud thinks about free tiers.",
        topics: ["pricing"],
      },
      {
        at: 52,
        type: "message",
        notes: "Quick check-in. She's hiring a PM and asked if I knew anyone.",
      },
    ],
    followUpInDays: 14,
  },
  {
    fullName: "Tom Bennett",
    firstName: "Tom",
    lastName: "Bennett",
    title: "Staff Software Engineer",
    company: "Stripe",
    location: "Remote",
    // High closeness, no follow-up scheduled, 96 days quiet: this is what the dashboard's
    // "Suggested outreach" queue is built to surface, so the seed has to produce a few.
    closeness: 4,
    howMet: "Open-source contributor on a library I maintain",
    metDaysAgo: 260,
    notes:
      "Reviewed a gnarly PR of mine and stayed to explain why. Works on Stripe's API platform. Happy to review architecture if asked directly.",
    keyFacts: ["Works on Stripe's API platform"],
    sharedInterests: ["open source"],
    tags: ["Engineering"],
    touches: [
      {
        at: 260,
        type: "message",
        notes: "First contact through a PR review on the library.",
      },
      {
        at: 96,
        type: "call",
        notes: "Screen-shared on API versioning. He argued for date-based versions.",
        topics: ["API design"],
      },
    ],
  },
  {
    fullName: "Nina Petrova",
    firstName: "Nina",
    lastName: "Petrova",
    title: "Co-founder & CEO",
    company: "Lumen Health",
    location: "Boston, MA",
    closeness: 4,
    priority: 2,
    howMet: "Y Combinator alumni Slack",
    metDaysAgo: 150,
    notes:
      "Second-time founder, sold her last company. The person I call when something is going badly. Has strong views on hiring the first five engineers.",
    keyFacts: ["Second-time founder", "Sold her last company in 2024"],
    tags: ["Founder", "Mentor"],
    touches: [
      {
        at: 150,
        type: "call",
        notes: "Intro call from the YC alumni Slack. Immediately useful on early hiring.",
        topics: ["hiring", "founders"],
      },
      {
        at: 40,
        type: "meeting",
        notes:
          "Dinner in Boston. Talked through Orbit's positioning — she pushed hard on picking one user, not four.",
        topics: ["positioning"],
      },
      {
        at: 11,
        type: "message",
        notes: "Sent her the revised positioning line. She liked it.",
      },
    ],
    followUpInDays: 25,
  },
  {
    fullName: "David Kim",
    firstName: "David",
    lastName: "Kim",
    title: "Engineering Manager",
    company: "OpenAI",
    location: "San Francisco, CA",
    closeness: 2,
    howMet: "Sarah introduced us over email",
    metDaysAgo: 38,
    notes:
      "Manages an applied team. We have only exchanged email so far. Sarah said he is the right person to talk to about evaluation infrastructure.",
    keyFacts: ["Introduced by Sarah Chen"],
    tags: ["AI"],
    touches: [
      {
        at: 38,
        type: "email",
        notes: "Intro email from Sarah. He replied, said to ping him in a few weeks.",
        topics: ["intro"],
      },
    ],
    followUpInDays: -2,
  },
  {
    fullName: "Rachel Adeyemi",
    firstName: "Rachel",
    lastName: "Adeyemi",
    title: "Director of Talent",
    company: "Figma",
    location: "New York, NY",
    closeness: 2,
    howMet: "Panel at a design systems meetup",
    metDaysAgo: 175,
    notes:
      "Spoke on the panel about hiring designers who can code. Said she is always happy to refer people even when Figma is not hiring.",
    tags: ["Hiring"],
    touches: [
      {
        at: 175,
        type: "note",
        notes: "Met after her panel at the design systems meetup. Swapped contacts.",
      },
    ],
  },
  {
    fullName: "Ben Carter",
    firstName: "Ben",
    lastName: "Carter",
    title: "Computer Science Student",
    school: "UNC Chapel Hill",
    company: "UNC Chapel Hill",
    location: "Chapel Hill, NC",
    closeness: 3,
    howMet: "Hackathon judging at UNC",
    metContext: "HackNC",
    metDaysAgo: 45,
    notes:
      "Built a genuinely good retrieval demo at HackNC in a weekend. Graduating in May and looking for an internship. Worth staying close to.",
    keyFacts: ["Graduating May 2027", "Built a retrieval demo at HackNC"],
    tags: ["UNC", "Student"],
    touches: [
      {
        at: 45,
        type: "meeting",
        notes:
          "Judged his HackNC project. Retrieval over course notes, shipped in a weekend, and he could explain every choice.",
        topics: ["HackNC", "UNC"],
      },
    ],
    followUpInDays: -20,
  },
  {
    fullName: "Sofia Marchetti",
    firstName: "Sofia",
    lastName: "Marchetti",
    title: "Design Lead",
    company: "Figma",
    location: "Remote",
    closeness: 3,
    priority: 2,
    howMet: "Rachel introduced us",
    metDaysAgo: 140,
    notes:
      "Gave Orbit's landing page a brutal and correct critique. Offered another pass whenever there is something new to look at.",
    keyFacts: ["Critiqued the Orbit landing page"],
    sharedInterests: ["design systems"],
    tags: ["Design"],
    touches: [
      {
        at: 140,
        type: "meeting",
        notes: "First call, introduced by Rachel. Ran through the landing page live.",
        topics: ["design"],
      },
      {
        at: 63,
        type: "message",
        notes: "Sent her the redesign. She replied with six specific fixes; four shipped.",
      },
    ],
  },
  {
    fullName: "Andre Silva",
    firstName: "Andre",
    lastName: "Silva",
    title: "Head of Platform",
    company: "Google",
    location: "Zurich, Switzerland",
    closeness: 2,
    howMet: "Conference talk Q&A",
    metDaysAgo: 320,
    notes:
      "Asked the sharpest question after my talk and we kept talking in the hallway. Time zones make this a slow relationship.",
    tags: ["Engineering"],
    touches: [
      {
        at: 320,
        type: "note",
        notes: "Hallway conversation after the talk about multi-region writes.",
      },
    ],
  },
  {
    fullName: "Maya Thompson",
    firstName: "Maya",
    lastName: "Thompson",
    title: "Program Director",
    company: "Innovate Carolina",
    school: "UNC Chapel Hill",
    location: "Chapel Hill, NC",
    closeness: 3,
    priority: 2,
    howMet: "Runs the venture program I applied to",
    metDaysAgo: 110,
    notes:
      "Gatekeeper in the best sense — knows every founder and funder in the Triangle. Asked me to present at the fall showcase.",
    keyFacts: ["Runs the Innovate Carolina venture program", "Invited me to the fall showcase"],
    tags: ["UNC"],
    touches: [
      {
        at: 110,
        type: "meeting",
        notes: "Program intro meeting. She mapped out who to meet in the Triangle.",
        topics: ["UNC"],
      },
      {
        at: 27,
        type: "email",
        notes: "Confirmed the showcase slot and sent the logistics.",
        topics: ["UNC", "showcase"],
      },
    ],
    followUpInDays: 3,
    reminder: {
      title: "Send Maya the showcase one-liner",
      description: "She needs the description for the programme by Friday.",
      inDays: 1,
    },
  },
  {
    fullName: "Hassan Ali",
    firstName: "Hassan",
    lastName: "Ali",
    title: "Senior Backend Engineer",
    company: "Notion",
    location: "Toronto, Canada",
    closeness: 2,
    howMet: "Priya's team offsite, joined a dinner",
    metDaysAgo: 55,
    notes: "Works alongside Priya. Quiet, extremely good at Postgres.",
    sharedInterests: ["Postgres"],
    touches: [
      { at: 55, type: "note", notes: "Dinner with Priya's team. Talked about Postgres indexing." },
    ],
  },
  {
    fullName: "Grace Whitfield",
    firstName: "Grace",
    lastName: "Whitfield",
    title: "Angel Investor",
    company: "Independent",
    location: "Durham, NC",
    closeness: 3,
    howMet: "Introduced by James Okafor",
    metDaysAgo: 48,
    notes:
      "Writes $25k–$50k angel checks, mostly into Triangle founders. Said she decides fast and expects a short update every quarter.",
    keyFacts: ["Angel, $25k–$50k checks", "Triangle-focused"],
    tags: ["Investor"],
    touches: [
      {
        at: 48,
        type: "call",
        notes: "Intro call from James. Direct, decides fast, wants quarterly updates.",
        topics: ["fundraising"],
      },
    ],
    followUpInDays: -7,
  },
  {
    fullName: "Leo Fernandez",
    firstName: "Leo",
    lastName: "Fernandez",
    title: "Founder",
    company: "Tidepool Analytics",
    location: "Austin, TX",
    closeness: 2,
    howMet: "Cold outreach that turned into a real conversation",
    metDaysAgo: 200,
    notes:
      "Building analytics for hardware teams. We trade notes on early sales. Slow to reply but always replies.",
    tags: ["Founder"],
    touches: [
      { at: 200, type: "email", notes: "He cold-emailed me; the second reply was worth it." },
      { at: 130, type: "call", notes: "Compared early sales motions. He does founder-led demos." },
    ],
  },
  {
    fullName: "Yuki Tanaka",
    firstName: "Yuki",
    lastName: "Tanaka",
    title: "Research Scientist",
    company: "Anthropic",
    location: "San Francisco, CA",
    closeness: 4,
    howMet: "Paper reading group",
    metDaysAgo: 180,
    notes:
      "Works on interpretability. Explained retrieval evaluation to me twice, patiently. Not a networking relationship — a learning one.",
    sharedInterests: ["interpretability", "evals"],
    tags: ["AI"],
    touches: [
      { at: 180, type: "note", notes: "Met at the paper reading group." },
      { at: 88, type: "message", notes: "Asked her about eval design; she sent three papers." },
    ],
  },
  {
    fullName: "Olivia Brooks",
    firstName: "Olivia",
    lastName: "Brooks",
    title: "Alumni Relations Lead",
    school: "UNC Chapel Hill",
    company: "UNC Chapel Hill",
    location: "Chapel Hill, NC",
    closeness: 2,
    howMet: "Alumni mixer",
    metDaysAgo: 230,
    notes: "Knows which alumni are worth an introduction and offers them unprompted.",
    tags: ["UNC"],
    touches: [{ at: 230, type: "note", notes: "Alumni mixer. She offered two introductions." }],
    followUpInDays: -31,
  },
  {
    fullName: "Chris Nowak",
    firstName: "Chris",
    lastName: "Nowak",
    title: "Engineering Manager",
    company: "Google",
    location: "New York, NY",
    closeness: 2,
    howMet: "Former coworker's referral",
    metDaysAgo: 300,
    notes: "Manages a search infra team. Aisha vouched for him. We have never met in person.",
    tags: ["Former coworker"],
    touches: [{ at: 300, type: "email", notes: "Referral intro from Aisha. Brief exchange." }],
  },
  {
    fullName: "Fatima Nasser",
    firstName: "Fatima",
    lastName: "Nasser",
    title: "Product Manager",
    company: "Stripe",
    location: "London, UK",
    closeness: 2,
    howMet: "Marcus introduced us",
    metDaysAgo: 30,
    notes:
      "Owns Stripe's onboarding surface. Offered to walk through how they measure activation.",
    keyFacts: ["Owns Stripe onboarding", "Offered an activation-metrics walkthrough"],
    touches: [
      { at: 30, type: "message", notes: "Intro from Marcus. She offered a walkthrough of activation metrics." },
    ],
    followUpInDays: 7,
  },
  {
    fullName: "Daniel Osei",
    firstName: "Daniel",
    lastName: "Osei",
    title: "Founder & CTO",
    company: "Northlight Robotics",
    location: "Pittsburgh, PA",
    closeness: 3,
    priority: 2,
    howMet: "Both spoke at the same founders panel",
    metDaysAgo: 95,
    notes:
      "Hardware founder, so most of our advice does not transfer — but he is the best person I know on hiring under uncertainty.",
    tags: ["Founder"],
    touches: [
      { at: 95, type: "meeting", notes: "Founders panel green room. Long talk about hiring." },
      { at: 58, type: "call", notes: "He talked me out of a bad first hire." },
    ],
  },
  {
    fullName: "Amara Diallo",
    firstName: "Amara",
    lastName: "Diallo",
    title: "Head of Talent",
    company: "Bellwether Ventures",
    location: "New York, NY",
    closeness: 2,
    howMet: "Works with James at Bellwether",
    metDaysAgo: 70,
    notes:
      "Runs talent across the portfolio. Said she keeps a list of engineers looking to move and shares it with portfolio founders.",
    keyFacts: ["Keeps a portfolio-wide candidate list"],
    tags: ["Hiring", "Investor"],
    touches: [{ at: 70, type: "note", notes: "Met through James. Offered access to the candidate list." }],
  },
  {
    fullName: "Victor Reyes",
    firstName: "Victor",
    lastName: "Reyes",
    title: "Software Engineer",
    school: "UNC Chapel Hill",
    company: "Anthropic",
    location: "San Francisco, CA",
    closeness: 3,
    howMet: "UNC alum, found me through the alumni Slack",
    metDaysAgo: 65,
    notes:
      "Graduated two years ahead of me, now on the inference team. Offered to review Orbit's prompt architecture and actually followed through.",
    keyFacts: ["UNC alum", "On Anthropic's inference team"],
    sharedInterests: ["UNC", "inference"],
    tags: ["UNC", "AI"],
    touches: [
      { at: 65, type: "message", notes: "He found me in the UNC alumni Slack." },
      {
        at: 29,
        type: "call",
        notes: "Reviewed Orbit's prompting. Told me to stop asking the model to count things it cannot see.",
        topics: ["prompting", "UNC"],
      },
    ],
    followUpInDays: 12,
  },
];

export const SHOWCASE_TAGS = [
  ...new Set(SHOWCASE_PEOPLE.flatMap((p) => p.tags ?? [])),
].sort();

export type ShowcaseSeedResult = {
  contacts: number;
  interactions: number;
  reminders: number;
  tags: number;
  tagLinks: number;
  companies: number;
  overdueFollowUps: number;
  upcomingFollowUps: number;
};

/**
 * Delete a user's network and replace it with the showcase fixture.
 *
 * DESTRUCTIVE, and deliberately narrower than `purgeUserData`: it clears exactly what it
 * is about to rewrite — contacts (which cascade to interactions, contact_tags, reminders
 * and embeddings) and tags — plus the two tables that do NOT cascade. `ai_suggestions` and
 * `suggested_reminders` reference contacts through a jsonb id array rather than a foreign
 * key, so skipping them leaves the dashboard showing an outreach queue built against
 * contacts that no longer exist.
 *
 * Everything outside the network is left alone: settings, API keys, plan, imports, chat
 * threads. This is "give me a known starting state", not "delete my account".
 *
 * Takes `userId` explicitly and does no auth of its own, matching the operator functions in
 * `admin-operations.ts` — the gate lives in the caller, which is what lets the CLI and the
 * server action share one implementation and a smoke test drive it with no request context.
 */
export async function seedShowcase(
  userId: string,
  opts: { now?: Date } = {}
): Promise<ShowcaseSeedResult> {
  const db = await getDb();
  const now = opts.now?.getTime() ?? Date.now();
  const ago = (days: number) => new Date(now - days * DAY);
  const ahead = (days: number) => new Date(now + days * DAY);

  await db.delete(aiSuggestions).where(eq(aiSuggestions.userId, userId));
  await db.delete(suggestedReminders).where(eq(suggestedReminders.userId, userId));
  await db.delete(reminders).where(eq(reminders.userId, userId));
  await db.delete(contacts).where(eq(contacts.userId, userId));
  await db.delete(tags).where(eq(tags.userId, userId));

  const rows: NewContact[] = SHOWCASE_PEOPLE.map((p) => {
    const touches = p.touches ?? [];
    // Only set the interaction stamps from real touches — the app distinguishes
    // "we spoke" from "you added them", and seeded data must not blur that.
    // `at` is days ago, so ascending order puts the MOST RECENT touch first.
    const sorted = [...touches].sort((a, b) => a.at - b.at);
    const lastAt = sorted.length ? ago(sorted[0].at) : ago(p.metDaysAgo);
    const firstAt = sorted.length ? ago(sorted[sorted.length - 1].at) : ago(p.metDaysAgo);
    return {
      userId,
      fullName: p.fullName,
      firstName: p.firstName,
      lastName: p.lastName,
      title: p.title,
      company: p.company ?? null,
      school: p.school ?? null,
      location: p.location ?? null,
      email: p.email ?? null,
      linkedinUrl: p.linkedinUrl ?? null,
      relationshipScore: p.closeness,
      statedCloseness: p.closeness,
      priorityLevel: p.priority ?? 0,
      source: "showcase-seed",
      howMet: p.howMet,
      metContext: p.metContext ?? null,
      dateMet: ago(p.metDaysAgo),
      notes: p.notes ?? null,
      keyFacts: p.keyFacts ?? [],
      sharedInterests: p.sharedInterests ?? [],
      firstInteractionAt: firstAt,
      lastInteractionAt: lastAt,
      nextFollowUpAt: p.followUpInDays == null ? null : ahead(p.followUpInDays),
      followUpStatus: p.followUpInDays == null ? "none" : "pending",
    } satisfies NewContact;
  });

  const inserted = await db.insert(contacts).values(rows).returning();
  const idByName = new Map(inserted.map((c) => [c.fullName, c.id]));

  const interactionRows = SHOWCASE_PEOPLE.flatMap((p) =>
    (p.touches ?? []).map((t) => ({
      userId,
      contactId: idByName.get(p.fullName)!,
      interactionType: t.type,
      interactionDate: ago(t.at),
      source: "showcase-seed",
      rawNotes: t.notes,
      topics: t.topics ?? [],
      actionItems: [] as string[],
    }))
  );
  if (interactionRows.length) {
    await db.insert(interactions).values(interactionRows);
  }

  const insertedTags = SHOWCASE_TAGS.length
    ? await db
        .insert(tags)
        .values(SHOWCASE_TAGS.map((name) => ({ userId, name })))
        .returning()
    : [];
  const tagIdByName = new Map(insertedTags.map((t) => [t.name, t.id]));
  const tagLinks = SHOWCASE_PEOPLE.flatMap((p) =>
    (p.tags ?? []).map((name) => ({
      contactId: idByName.get(p.fullName)!,
      tagId: tagIdByName.get(name)!,
    }))
  );
  if (tagLinks.length) {
    await db.insert(contactTags).values(tagLinks);
  }

  const reminderRows = SHOWCASE_PEOPLE.flatMap((p) =>
    p.reminder
      ? [
          {
            userId,
            contactId: idByName.get(p.fullName)!,
            title: p.reminder.title,
            description: p.reminder.description ?? null,
            dueDate: ahead(p.reminder.inDays),
            status: "pending",
            reminderType: "manual",
            actionKind: "follow_up" as const,
            createdBy: "user",
          },
        ]
      : []
  );
  if (reminderRows.length) {
    await db.insert(reminders).values(reminderRows);
  }

  return {
    contacts: inserted.length,
    interactions: interactionRows.length,
    reminders: reminderRows.length,
    tags: insertedTags.length,
    tagLinks: tagLinks.length,
    companies: new Set(SHOWCASE_PEOPLE.map((p) => p.company).filter(Boolean)).size,
    overdueFollowUps: SHOWCASE_PEOPLE.filter((p) => (p.followUpInDays ?? 1) < 0).length,
    upcomingFollowUps: SHOWCASE_PEOPLE.filter((p) => (p.followUpInDays ?? -1) > 0).length,
  };
}
