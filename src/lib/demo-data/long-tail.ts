/**
 * The long tail of the extended demo workspace: the few dozen lighter relationships every
 * real network has around its core — LinkedIn connections from a conference, an address-book
 * import, people met once at an event and emailed twice since.
 *
 * Generated, not hand-written, but deterministic: a seeded PRNG over fixed pools, so every
 * reseed produces the same people with the same histories and a demo can be rehearsed. No
 * name here is a real person's; companies are real so the constellation clusters the way a
 * real network does (several people at Stripe, Google, OpenAI…), and every email address is
 * on a reserved `example.*` domain so nothing can ever be sent to it.
 *
 * Pure data. The writer is `seed.ts`.
 */
import type { DemoPerson, DemoTouch, DemoTouchType } from "@/lib/demo-data/network";

export const LONG_TAIL_SIZE = 60;

/** mulberry32: tiny, fast, and the same sequence for the same seed on every platform. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WOMEN = [
  "Hannah", "Isabel", "Mei", "Zoe", "Camila", "Leah", "Ananya", "Chloe", "Nadia", "Grace",
  "Julia", "Ava", "Sophie", "Keiko", "Lucia", "Erin", "Tara", "Imani", "Clara", "Rosa",
  "Naomi", "Freya", "Lina", "Emily", "Adaeze", "Ingrid", "Selin", "Paige", "Riya", "Elise",
];
const MEN = [
  "Ethan", "Rohan", "Mateo", "Noah", "Kwame", "Lucas", "Arjun", "Owen", "Jonas", "Samir",
  "Theo", "Diego", "Kai", "Felix", "Omar", "Ryan", "Julian", "Wei", "Caleb", "Tariq",
  "Adrian", "Marco", "Nikhil", "Sean", "Emeka", "Henrik", "Luca", "Isaac", "Ravi", "Miles",
];
const LAST = [
  "Park", "Alvarez", "Novak", "Harper", "Osei", "Lindqvist", "Mehta", "Kowalski", "Brennan",
  "Sato", "Moreau", "Hughes", "Achebe", "Rossi", "Castillo", "Byrne", "Iyer", "Fischer",
  "Delgado", "Nakamura", "Whitaker", "Adebayo", "Kaur", "Sorensen", "Quinn", "Haddad",
  "Pereira", "Lambert", "Choi", "Ferreira", "Donovan", "Abara", "Kim", "Vance", "Yilmaz",
  "Duarte", "Ellison", "Grant", "Hoffman", "Rahimi", "Tran", "Wolfe", "Okonkwo", "Mercer",
];

type Org = { company: string; location: string; titles: string[]; tags: string[] };
const ORGS: Org[] = [
  { company: "Stripe", location: "San Francisco, CA", titles: ["Software Engineer", "Product Designer", "Solutions Architect"], tags: ["Engineering"] },
  { company: "Google", location: "Mountain View, CA", titles: ["Software Engineer", "Product Manager", "UX Researcher"], tags: ["Engineering"] },
  { company: "OpenAI", location: "San Francisco, CA", titles: ["Research Engineer", "Member of Technical Staff", "Developer Advocate"], tags: ["AI"] },
  { company: "Anthropic", location: "San Francisco, CA", titles: ["Research Engineer", "Product Manager"], tags: ["AI"] },
  { company: "Notion", location: "New York, NY", titles: ["Software Engineer", "Growth Lead"], tags: ["Engineering"] },
  { company: "Figma", location: "San Francisco, CA", titles: ["Product Designer", "Design Engineer"], tags: ["Design"] },
  { company: "Vercel", location: "Remote", titles: ["Developer Experience Engineer", "Solutions Engineer"], tags: ["Engineering"] },
  { company: "Datadog", location: "New York, NY", titles: ["Site Reliability Engineer", "Engineering Manager"], tags: ["Engineering"] },
  { company: "Ramp", location: "New York, NY", titles: ["Software Engineer", "Product Manager"], tags: ["Engineering"] },
  { company: "Databricks", location: "Seattle, WA", titles: ["Data Engineer", "Solutions Architect"], tags: ["AI"] },
  { company: "Microsoft", location: "Redmond, WA", titles: ["Program Manager", "Senior Software Engineer"], tags: ["Engineering"] },
  { company: "Epic Games", location: "Cary, NC", titles: ["Gameplay Engineer", "Technical Artist"], tags: ["Engineering"] },
  { company: "Red Hat", location: "Raleigh, NC", titles: ["Principal Engineer", "Developer Advocate"], tags: ["Engineering"] },
  { company: "SAS", location: "Cary, NC", titles: ["Data Scientist", "Product Manager"], tags: ["AI"] },
  { company: "UNC Chapel Hill", location: "Chapel Hill, NC", titles: ["PhD Candidate, Computer Science", "Computer Science Student", "Research Associate"], tags: ["UNC", "Student"] },
  { company: "Duke University", location: "Durham, NC", titles: ["MBA Candidate", "Research Scientist"], tags: ["Student"] },
  { company: "Sequoia Capital", location: "Menlo Park, CA", titles: ["Investor", "Scout"], tags: ["Investor"] },
  { company: "Pear VC", location: "Palo Alto, CA", titles: ["Partner", "Associate"], tags: ["Investor"] },
  { company: "Lattice", location: "San Francisco, CA", titles: ["Recruiter", "Head of People"], tags: ["Hiring"] },
  { company: "Airtable", location: "Remote", titles: ["Founding Engineer", "Engineering Manager"], tags: ["Founder"] },
  { company: "Relay Robotics", location: "Pittsburgh, PA", titles: ["Co-founder & CEO", "Founding Engineer"], tags: ["Founder"] },
  { company: "Harbor Health", location: "Austin, TX", titles: ["Founder", "Head of Product"], tags: ["Founder"] },
];

const PREVIOUS = ["Meta", "Amazon", "Salesforce", "IBM", "Shopify", "Twilio", "Dropbox", "Cisco", "Deloitte", "Capital One"];
const SCHOOLS = ["UNC Chapel Hill", "Duke University", "NC State University", "Georgia Tech", "University of Michigan", "UC Berkeley", "Carnegie Mellon University"];
const FIELDS = ["Computer Science", "Business Administration", "Economics", "Information Science", "Electrical Engineering", "Statistics"];

const HOW_MET: Array<{ howMet: string; source: LongTailSource }> = [
  { howMet: "LinkedIn connection after the AWS Summit", source: "linkedin" },
  { howMet: "Imported from Google Contacts", source: "google_contacts" },
  { howMet: "Met at a Triangle founders meetup", source: "ai_capture" },
  { howMet: "UNC alumni Slack", source: "linkedin" },
  { howMet: "Outlook address book — former coworker", source: "outlook_contacts" },
  { howMet: "HackNC 2026", source: "ai_capture" },
  { howMet: "Calendar invite for a product demo", source: "google_contacts" },
  { howMet: "Innovate Carolina cohort", source: "ai_capture" },
  { howMet: "Introduced over email by a mutual friend", source: "google_contacts" },
  { howMet: "Commented on my launch post on LinkedIn", source: "linkedin" },
];

export type LongTailSource = "linkedin" | "google_contacts" | "outlook_contacts" | "ai_capture";

const TOPICS = [
  "hiring", "developer tools", "AI infrastructure", "fundraising", "product design", "career advice",
  "go-to-market", "data pipelines", "open source", "pricing", "user research", "Postgres",
];

const TOUCH_TEMPLATES: Record<DemoTouchType, Array<(first: string, company: string, topic: string) => string>> = {
  email: [
    (f, c, t) => `Emailed ${f} a short follow-up on ${t}; they replied with two useful links from ${c}.`,
    (f, _c, t) => `${f} sent over notes on ${t} after our last conversation.`,
    (f, c) => `Sent ${f} a quick Orbit update. They forwarded it to a teammate at ${c}.`,
  ],
  call: [
    (f, c, t) => `Twenty-minute call with ${f} about ${t}. Good read on how ${c} approaches it.`,
    (f, _c, t) => `Caught up with ${f} by phone — mostly ${t}, plus what they're working on next.`,
  ],
  meeting: [
    (f, c, t) => `Google Meet with ${f} (${c}) on ${t}. Clear next steps on both sides.`,
    (f, _c, t) => `Calendar meeting with ${f}: walked through Orbit and got blunt feedback on ${t}.`,
  ],
  linkedin_message: [
    (f, c) => `Connected with ${f} on LinkedIn and said hello — they're at ${c} now.`,
    (f, _c, t) => `${f} messaged on LinkedIn asking about ${t}.`,
  ],
  message: [
    (f, _c, t) => `Swapped a few messages with ${f} about ${t}.`,
  ],
  in_person: [
    (f, _c, t) => `Coffee with ${f}. Talked ${t} and life after the last job change.`,
  ],
  event: [
    (f, c) => `Met ${f} from ${c} at a meetup; exchanged contacts at the end.`,
  ],
  note: [
    (f, c, t) => `${f} at ${c} is the person to ask about ${t}.`,
  ],
  intro: [
    (f, _c, t) => `Introduced ${f} to someone in my network working on ${t}.`,
  ],
};

const TYPE_WEIGHTS: Array<[DemoTouchType, number]> = [
  ["email", 5], ["linkedin_message", 3], ["meeting", 3], ["call", 2], ["message", 2], ["in_person", 1], ["event", 1], ["note", 1],
];

export type LongTailPerson = DemoPerson & { gender: "f" | "m"; source: LongTailSource };

/**
 * The long tail, in a fixed order. `taken` is every name already in the cast, so no
 * generated person collides with a hand-written one.
 */
export function buildLongTail(taken: ReadonlySet<string>, size = LONG_TAIL_SIZE): LongTailPerson[] {
  const rand = prng(0x0b17);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const weightedType = () => {
    const total = TYPE_WEIGHTS.reduce((s, [, w]) => s + w, 0);
    let r = rand() * total;
    for (const [type, w] of TYPE_WEIGHTS) if ((r -= w) < 0) return type;
    return "email" as DemoTouchType;
  };

  const people: LongTailPerson[] = [];
  const used = new Set(taken);
  let guard = 0;
  while (people.length < size && guard++ < size * 20) {
    const gender = rand() < 0.5 ? "f" : "m";
    const firstName = pick(gender === "f" ? WOMEN : MEN);
    const lastName = pick(LAST);
    const fullName = `${firstName} ${lastName}`;
    if (used.has(fullName)) continue;
    used.add(fullName);

    const org = pick(ORGS);
    const title = pick(org.titles);
    const met = pick(HOW_MET);
    const metDaysAgo = between(40, 620);
    // Closeness skews low, the way a real long tail does: most are 1–2, a few are 3.
    const r = rand();
    const closeness = r < 0.45 ? 1 : r < 0.85 ? 2 : 3;

    const touchCount = between(2, 4);
    const days = new Set<number>();
    while (days.size < touchCount) days.add(between(3, metDaysAgo));
    const touches: DemoTouch[] = [...days]
      .sort((a, b) => b - a)
      .map((at, i) => {
        // The first touch is how you met; the rest are whatever the relationship did since.
        const type: DemoTouchType = i === 0 && met.source === "ai_capture" ? "event" : weightedType();
        const topic = pick(TOPICS);
        const touch: DemoTouch = {
          at,
          type,
          notes: pick(TOUCH_TEMPLATES[type])(firstName, org.company, topic),
          topics: [topic],
        };
        if (type === "linkedin_message") touch.direction = rand() < 0.5 ? "in" : "out";
        return touch;
      });

    const domain = pick(["example.com", "example.org", "example.net"]);
    const startYear = between(2018, 2024);
    const previous = pick(PREVIOUS);
    const school = pick(SCHOOLS);
    const gradYear = startYear - between(0, 3);
    const followUp = rand();

    people.push({
      gender,
      source: met.source,
      fullName,
      firstName,
      lastName,
      title,
      company: org.company,
      location: org.location,
      school: rand() < 0.4 ? school : undefined,
      email: `${firstName}.${lastName}@${domain}`.toLowerCase(),
      linkedinUrl:
        met.source === "linkedin" || rand() < 0.5
          ? `https://www.linkedin.com/in/${firstName}-${lastName}-demo`.toLowerCase()
          : undefined,
      closeness,
      howMet: met.howMet,
      metDaysAgo,
      notes: `${title} at ${org.company}. Good to know for ${pick(TOPICS)}.`,
      tags: rand() < 0.7 ? org.tags.slice(0, 1) : [],
      touches,
      followUpInDays: followUp < 0.12 ? -between(2, 20) : followUp < 0.3 ? between(3, 30) : undefined,
      standing:
        closeness >= 3
          ? `Friendly and reachable — last spoke ${touches[touches.length - 1].at} days ago.`
          : `A lighter tie from ${met.howMet.toLowerCase()}. Worth a note when ${pick(TOPICS)} comes up.`,
      history: org.tags.includes("Student")
        ? [[org.company, title, startYear, null]]
        : [
            [org.company, title, startYear, null],
            [previous, pick(["Software Engineer", "Analyst", "Associate", "Product Manager", "Designer"]), gradYear, startYear],
          ],
      education: [[school, pick(FIELDS), gradYear - 4, gradYear]],
    });
  }
  return people;
}
