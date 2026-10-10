/**
 * The six example people the guided tour plants before it walks the real pages, as data:
 * an early-career network (an alum, a recruiter, a manager, a professor, a classmate, a founder).
 *
 * Every page the tour visits needs something true to show: the dashboard wants someone
 * overdue, Reminders wants one due today, the Constellation wants three people at one
 * company with logged interactions, and Chat wants a question it can answer from notes.
 * The cast is built backwards from those stops.
 *
 * Identities are on `example.com` (RFC 2606, reserved forever) and LinkedIn slugs start with
 * `orbit-example-`, so no real import can ever collide with, or be merged into, one of them.
 * Names are fictional and distinctive enough that a capture during the tour resolving to
 * "a new Priya Natarajan" is still recognisably the example (see `remove.ts`).
 *
 * No embeddings are written: `embeddingStaleAt` stays null so the backfill never claims
 * these rows, and Chat finds them through the keyword arm of hybrid search — name, company,
 * notes and summary — which is what "who do I know at Lumen Labs" needs.
 */

export const EXAMPLE_COMPANY = "Lumen Labs";
export const EXAMPLE_COMPANY_SECOND = "Northwind Robotics";
const EXAMPLE_SCHOOL = "Redwood University";

export type ExampleTouch = {
  type: "note" | "meeting" | "call" | "in_person" | "email" | "message";
  /** Days ago; always in the past and within the last two months. */
  at: number;
  notes: string;
  topics?: string[];
  actionItems?: string[];
};

export type ExamplePerson = {
  key: string;
  fullName: string;
  firstName: string;
  lastName: string;
  title: string;
  company: string | null;
  school: string | null;
  location: string;
  email: string;
  linkedinSlug: string;
  /** 1–5, the same scale as the contact form's Strength field. */
  closeness: number;
  howMet: string;
  metContext: string;
  metDaysAgo: number;
  keyFacts: string[];
  notes: string;
  /** The brief's one-line "where things stand". */
  standing: string;
  touches: ExampleTouch[];
  /** Days from now for `next_follow_up_at`; negative = overdue; null = none. */
  followUpInDays: number | null;
  reminder: { title: string; description: string; inDays: number } | null;
};

export const EXAMPLE_PEOPLE: ExamplePerson[] = [
  {
    key: "priya",
    fullName: "Priya Natarajan",
    firstName: "Priya",
    lastName: "Natarajan",
    title: "Software Engineer",
    company: EXAMPLE_COMPANY,
    school: EXAMPLE_SCHOOL,
    location: "Seattle",
    email: "priya.natarajan@example.com",
    linkedinSlug: "orbit-example-priya-natarajan",
    closeness: 4,
    howMet: "An alumni mixer, then a coffee chat the week after",
    metContext: "Alumni mixer",
    metDaysAgo: 50,
    keyFacts: ["Redwood alum, two years ahead", "On Lumen Labs’ platform team"],
    notes: "Generous with time. Offered to refer you once your resume is ready.",
    standing: "Warm; she offered a referral and is waiting on your resume.",
    touches: [
      {
        type: "note",
        at: 4,
        notes:
          "Coffee chat about Lumen Labs’ new-grad loop. She’ll refer me once my resume leads with the internship. Asked me to send it by Friday.",
        topics: ["referral", "new-grad loop", "resume"],
        actionItems: ["Send Priya your updated resume"],
      },
      {
        type: "meeting",
        at: 30,
        notes: "Follow-up call after the mixer. Walked through how her team interviews: one system design, two coding rounds.",
        topics: ["interviews"],
      },
    ],
    followUpInDays: -3,
    reminder: {
      title: "Send Priya your updated resume",
      description: "She offered a referral over coffee; it starts when she has the resume.",
      inDays: -3,
    },
  },
  {
    key: "marcus",
    fullName: "Marcus Bell",
    firstName: "Marcus",
    lastName: "Bell",
    title: "University Recruiter",
    company: EXAMPLE_COMPANY,
    school: null,
    location: "Seattle",
    email: "marcus.bell@example.com",
    linkedinSlug: "orbit-example-marcus-bell",
    closeness: 2,
    howMet: "The Lumen Labs booth at the fall career fair",
    metContext: "Fall career fair",
    metDaysAgo: 21,
    keyFacts: ["Runs Lumen Labs’ new-grad hiring", "Said applications open this month"],
    notes: "Asked you to email him once you apply so he can flag it.",
    standing: "A fresh contact; email him after you apply.",
    touches: [
      {
        type: "in_person",
        at: 21,
        notes: "Career fair booth. New-grad applications open this month; email him after applying and he’ll flag it for the team.",
        topics: ["new-grad hiring"],
        actionItems: ["Email Marcus after you apply"],
      },
    ],
    followUpInDays: null,
    reminder: { title: "Email Marcus after you apply", description: "He’ll flag your application for the team.", inDays: 0 },
  },
  {
    key: "elena",
    fullName: "Elena Vasquez",
    firstName: "Elena",
    lastName: "Vasquez",
    title: "Engineering Manager",
    company: EXAMPLE_COMPANY,
    school: null,
    location: "Seattle",
    email: "elena.vasquez@example.com",
    linkedinSlug: "orbit-example-elena-vasquez",
    closeness: 4,
    howMet: "Your manager during last summer’s internship",
    metContext: "Summer internship",
    metDaysAgo: 58,
    keyFacts: ["Managed your internship", "Writes the return-offer recommendations"],
    notes: "Strong supporter. Wants to hear how the fall goes.",
    standing: "Close; check in before return offers are decided.",
    touches: [
      {
        type: "call",
        at: 25,
        notes: "Post-internship check-in. Return offers are decided next month; she’ll put in a word with the new-grad team.",
        topics: ["return offer"],
      },
    ],
    followUpInDays: 9,
    reminder: null,
  },
  {
    key: "grace",
    fullName: "Grace Holloway",
    firstName: "Grace",
    lastName: "Holloway",
    title: "Professor of Computer Science",
    company: null,
    school: EXAMPLE_SCHOOL,
    location: "Portland",
    email: "grace.holloway@example.com",
    linkedinSlug: "orbit-example-grace-holloway",
    closeness: 3,
    howMet: "You took her Algorithms course",
    metContext: "Algorithms course",
    metDaysAgo: 60,
    keyFacts: ["Taught your Algorithms course", "Happy to write recommendation letters"],
    notes: "Wants a short summary of your projects before she writes a letter.",
    standing: "Supportive; she’ll write a letter once you send a project summary.",
    touches: [
      {
        type: "in_person",
        at: 14,
        notes: "Office hours. She’ll write a recommendation letter and asked for a one-page summary of my projects first.",
        topics: ["recommendation letter"],
      },
    ],
    followUpInDays: null,
    reminder: {
      title: "Send Professor Holloway your project summary",
      description: "She’ll write the letter once she has it.",
      inDays: 5,
    },
  },
  {
    key: "jordan",
    fullName: "Jordan Kim",
    firstName: "Jordan",
    lastName: "Kim",
    title: "Computer Science student",
    company: null,
    school: EXAMPLE_SCHOOL,
    location: "Portland",
    email: "jordan.kim@example.com",
    linkedinSlug: "orbit-example-jordan-kim",
    closeness: 5,
    howMet: "Lab partner in Operating Systems",
    metContext: "Operating Systems lab",
    metDaysAgo: 59,
    keyFacts: ["Your lab partner", "Also applying for new-grad roles"],
    notes: "Mock interview swaps every week.",
    standing: "Close; you trade mock interviews every week.",
    touches: [{ type: "message", at: 3, notes: "Set up Thursday’s mock interview swap. Jordan takes system design this time.", topics: ["mock interviews"] }],
    followUpInDays: null,
    reminder: null,
  },
  {
    key: "sam",
    fullName: "Sam Okafor",
    firstName: "Sam",
    lastName: "Okafor",
    title: "Founder",
    company: EXAMPLE_COMPANY_SECOND,
    school: null,
    location: "Portland",
    email: "sam.okafor@example.com",
    linkedinSlug: "orbit-example-sam-okafor",
    closeness: 2,
    howMet: "The startup row at the fall career fair",
    metContext: "Fall career fair",
    metDaysAgo: 21,
    keyFacts: ["Six-person robotics startup", "Hiring a first new-grad engineer"],
    notes: "Liked the drone project. Asked for your GitHub.",
    standing: "Interested; send your GitHub while you’re fresh in mind.",
    touches: [
      {
        type: "in_person",
        at: 20,
        notes: "Career fair startup row. Northwind Robotics is hiring its first new-grad engineer; he asked for my GitHub and the drone project.",
        topics: ["startups", "robotics"],
        actionItems: ["Send Sam your GitHub"],
      },
    ],
    followUpInDays: null,
    reminder: null,
  },
];

/** What the tour pre-fills on the Capture stop, so the extraction lands on an example person. */
export const TOUR_EXAMPLE_NOTE =
  "Coffee chat with Priya Natarajan from Lumen Labs about the new-grad loop. She’ll refer me once my resume leads with the internship. Send her the updated resume by Friday.";

/** Names the remover also sweeps for, in case a capture created an unmarked twin. */
export const EXAMPLE_FULL_NAMES: readonly string[] = EXAMPLE_PEOPLE.map((p) => p.fullName);

/** Company names the remover deletes when no contact references them any more. */
export const EXAMPLE_COMPANY_NAMES: readonly string[] = [EXAMPLE_COMPANY, EXAMPLE_COMPANY_SECOND];

export function examplePerson(key: string): ExamplePerson {
  const person = EXAMPLE_PEOPLE.find((p) => p.key === key);
  if (!person) throw new Error(`No example person "${key}"`);
  return person;
}
