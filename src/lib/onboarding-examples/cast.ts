/**
 * The six example people the guided tour plants before it walks the real pages, as data.
 *
 * Every page the tour visits needs something true to show: the dashboard wants someone
 * overdue, Reminders wants one due today, the Constellation wants three people at one
 * company with logged interactions, and Chat wants a question it can answer from notes.
 * The cast is built backwards from those stops.
 *
 * Identities are on `example.com` (RFC 2606, reserved forever) and LinkedIn slugs start with
 * `orbit-example-`, so no real import can ever collide with, or be merged into, one of them.
 * Names are fictional and distinctive enough that a capture during the tour resolving to
 * "a new Maya Okonkwo-Reyes" is still recognisably the example (see `remove.ts`).
 *
 * No embeddings are written: `embeddingStaleAt` stays null so the backfill never claims
 * these rows, and Chat finds them through the keyword arm of hybrid search — name, company,
 * notes and summary — which is what "who do I know at Lumen Labs" needs.
 */

export const EXAMPLE_COMPANY = "Lumen Labs";
export const EXAMPLE_COMPANY_SECOND = "Northwind Capital";

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
    key: "maya",
    fullName: "Maya Okonkwo-Reyes",
    firstName: "Maya",
    lastName: "Okonkwo-Reyes",
    title: "Product Lead",
    company: EXAMPLE_COMPANY,
    school: null,
    location: "Amsterdam",
    email: "maya.okonkwo-reyes@example.com",
    linkedinSlug: "orbit-example-maya-okonkwo-reyes",
    closeness: 5,
    howMet: "A product meetup, then coffee the week after",
    metContext: "Product meetup",
    metDaysAgo: 74,
    keyFacts: ["Runs product at Lumen Labs", "Moving to Berlin in March"],
    notes: "Sharp on onboarding flows. Offered to review ours once the deck is ready.",
    standing: "Close and warm; you owe her the onboarding deck.",
    touches: [
      {
        type: "note",
        at: 4,
        notes:
          "Coffee near the canal. She’s moving to Berlin in March and wants an intro to a product designer there. Asked to see our onboarding deck.",
        topics: ["onboarding", "Berlin", "design intros"],
        actionItems: ["Send Maya the onboarding deck"],
      },
      {
        type: "meeting",
        at: 31,
        notes: "Walked her through the roadmap. She pushed back on the pricing page order, rightly.",
        topics: ["roadmap", "pricing"],
      },
    ],
    followUpInDays: -3,
    reminder: {
      title: "Send Maya the onboarding deck",
      description: "She asked for it over coffee; she’s reviewing it before Berlin.",
      inDays: -3,
    },
  },
  {
    key: "daniel",
    fullName: "Daniel Achterberg",
    firstName: "Daniel",
    lastName: "Achterberg",
    title: "Founding Engineer",
    company: EXAMPLE_COMPANY,
    school: null,
    location: "Amsterdam",
    email: "daniel.achterberg@example.com",
    linkedinSlug: "orbit-example-daniel-achterberg",
    closeness: 3,
    howMet: "Maya introduced you after the meetup",
    metContext: "Intro from Maya",
    metDaysAgo: 68,
    keyFacts: ["Owns Lumen Labs’ API", "Piloting a partner integration"],
    notes: "Wants a technical partner for the API pilot; asked good questions about rate limits.",
    standing: "Interested in the API pilot; a call is due.",
    touches: [
      {
        type: "call",
        at: 12,
        notes: "Twenty minutes on the API pilot. He needs webhook examples and a sandbox key before the end of the month.",
        topics: ["API pilot", "webhooks"],
        actionItems: ["Call Daniel about the API pilot"],
      },
    ],
    followUpInDays: null,
    reminder: {
      title: "Call Daniel about the API pilot",
      description: "He wanted webhook examples and a sandbox key.",
      inDays: 0,
    },
  },
  {
    key: "aisha",
    fullName: "Aisha Rahman",
    firstName: "Aisha",
    lastName: "Rahman",
    title: "Marketing Manager",
    company: EXAMPLE_COMPANY,
    school: null,
    location: "Rotterdam",
    email: "aisha.rahman@example.com",
    linkedinSlug: "orbit-example-aisha-rahman",
    closeness: 2,
    howMet: "Sat together at the Lumen Labs offsite dinner",
    metContext: "Lumen Labs offsite",
    metDaysAgo: 45,
    keyFacts: ["Runs Lumen Labs’ newsletter", "Looking for guest writers"],
    notes: "Mentioned the newsletter takes guest posts; a good way to reach their customers.",
    standing: "Friendly acquaintance; a guest post would be the next step.",
    touches: [
      {
        type: "in_person",
        at: 45,
        notes: "Offsite dinner. She runs the newsletter and is looking for guest writers on customer research.",
        topics: ["newsletter", "guest posts"],
      },
    ],
    followUpInDays: 9,
    reminder: null,
  },
  {
    key: "sofia",
    fullName: "Sofia Marchetti",
    firstName: "Sofia",
    lastName: "Marchetti",
    title: "Venture Associate",
    company: EXAMPLE_COMPANY_SECOND,
    school: null,
    location: "London",
    email: "sofia.marchetti@example.com",
    linkedinSlug: "orbit-example-sofia-marchetti",
    closeness: 2,
    howMet: "Demo day, in the queue for coffee",
    metContext: "Demo day",
    metDaysAgo: 60,
    keyFacts: ["Covers early-stage B2B at Northwind", "Asked for a traction update"],
    notes: "Wants monthly numbers before her partners meeting. Direct and quick to reply.",
    standing: "Watching from a distance; she asked for numbers.",
    touches: [
      {
        type: "email",
        at: 20,
        notes: "She replied to the demo-day follow-up asking for a traction update before her next partners meeting.",
        topics: ["traction", "fundraising"],
      },
    ],
    followUpInDays: null,
    reminder: {
      title: "Share the traction update with Sofia",
      description: "Before her partners meeting.",
      inDays: 5,
    },
  },
  {
    key: "tomasz",
    fullName: "Tomasz Wisniewski",
    firstName: "Tomasz",
    lastName: "Wisniewski",
    title: "PhD student",
    company: null,
    school: "Redwood University",
    location: "Utrecht",
    email: "tomasz.wisniewski@example.com",
    linkedinSlug: "orbit-example-tomasz-wisniewski",
    closeness: 3,
    howMet: "A university seminar on network science",
    metContext: "University seminar",
    metDaysAgo: 88,
    keyFacts: ["Researches graph layouts", "Defending next spring"],
    notes: "Sent over two papers on force-directed layouts. Curious about how Orbit draws its sky.",
    standing: "Good conversation partner; no ask outstanding.",
    touches: [
      {
        type: "message",
        at: 8,
        notes: "Messaged about the constellation layout paper he sent. He offered to look at our clustering.",
        topics: ["graph layout", "research"],
      },
    ],
    followUpInDays: null,
    reminder: null,
  },
  {
    key: "ben",
    fullName: "Ben Castellanos",
    firstName: "Ben",
    lastName: "Castellanos",
    title: "Independent developer",
    company: null,
    school: null,
    location: "Amsterdam",
    email: "ben.castellanos@example.com",
    linkedinSlug: "orbit-example-ben-castellanos",
    closeness: 4,
    howMet: "Old friend; you run together on Sundays",
    metContext: "Sunday runs",
    metDaysAgo: 90,
    keyFacts: ["Builds developer tools solo", "Training for a half marathon"],
    notes: "The person you think out loud with. Knows everyone in the local dev scene.",
    standing: "Close friend; nothing owed either way.",
    touches: [
      {
        type: "in_person",
        at: 2,
        notes: "Sunday run. He’s weighing an offer from a bigger company versus staying independent.",
        topics: ["career", "running"],
      },
      {
        type: "note",
        at: 16,
        notes: "He introduced you to two people at the dev meetup; follow up with both.",
        topics: ["intros", "dev meetup"],
      },
    ],
    followUpInDays: null,
    reminder: null,
  },
];

/** What the tour pre-fills on the Capture stop, so the extraction lands on an example person. */
export const TOUR_EXAMPLE_NOTE =
  "Coffee with Maya Okonkwo-Reyes from Lumen Labs — she’s moving to Berlin in March and wants an intro to a product designer. Send her the onboarding deck by Friday.";

/** Names the remover also sweeps for, in case a capture created an unmarked twin. */
export const EXAMPLE_FULL_NAMES: readonly string[] = EXAMPLE_PEOPLE.map((p) => p.fullName);

/** Company names the remover deletes when no contact references them any more. */
export const EXAMPLE_COMPANY_NAMES: readonly string[] = [EXAMPLE_COMPANY, EXAMPLE_COMPANY_SECOND];

export function examplePerson(key: string): ExamplePerson {
  const person = EXAMPLE_PEOPLE.find((p) => p.key === key);
  if (!person) throw new Error(`No example person "${key}"`);
  return person;
}
