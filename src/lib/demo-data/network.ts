/**
 * The demo network: a small, hand-written cast built to show Orbit end to end.
 *
 * ~25 people with real texture — notes worth reading, logged interactions so closeness and
 * timelines are earned rather than implied, work history so the profile timeline has roles
 * and schools, repeated companies so the constellation clusters and "who do I know at X?"
 * has more than one answer, and a deliberate spread of overdue / upcoming / healthy
 * follow-ups so the dashboard and the reminders page both have something to say.
 *
 * Pure data. The writer is `seed.ts`; nothing here touches the database.
 */

export type DemoTouchType =
  | "note"
  | "meeting"
  | "email"
  | "call"
  | "message"
  | "in_person"
  | "linkedin_message"
  | "event"
  | "intro";

export type DemoTouch = {
  /** Days ago. */
  at: number;
  type: DemoTouchType;
  notes: string;
  topics?: string[];
  /** Only meaningful for `linkedin_message`: who sent it. */
  direction?: "in" | "out";
  /** Open next steps, shown on the timeline and the profile. */
  actionItems?: string[];
};

/** [organization, title, startYear, endYear | null (current)] */
export type DemoRole = [string, string, number, number | null];
/** [school, field of study, startYear, endYear] */
export type DemoSchool = [string, string, number, number];

export type DemoPerson = {
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
  touches?: DemoTouch[];
  /** Days: negative = overdue, positive = upcoming, undefined = no follow-up set. */
  followUpInDays?: number;
  /** A reminder row, so the Reminders page and the bell are not empty. */
  reminder?: { title: string; description?: string; inDays: number; list?: string };
  /** The profile brief's "where things stand" line. */
  standing: string;
  /** Roles, most recent first. */
  history?: DemoRole[];
  education?: DemoSchool[];
};

/**
 * The cast. Companies repeat on purpose (OpenAI x3, Stripe x3, Google x3, UNC x4) so the
 * constellation forms real clusters.
 */
export const DEMO_PEOPLE: DemoPerson[] = [
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
        type: "event",
        notes:
          "Met at the AWS Summit after the inference keynote. Talked through AI infrastructure costs — she thinks most teams over-provision by 3-4x. Mentioned the Codex partnerships team is looking at developer-tool integrations.",
        topics: ["AI infrastructure", "AWS Summit"],
      },
      {
        at: 58,
        type: "linkedin_message",
        direction: "out",
        notes: "Connected on LinkedIn and thanked her for the conversation about inference costs.",
      },
      {
        at: 57,
        type: "linkedin_message",
        direction: "in",
        notes: "She replied asking for the retrieval write-up by email rather than here.",
      },
      {
        at: 43,
        type: "email",
        notes:
          "Sent a first draft of the write-up. She replied same day, said she'd share it with her team and to ping her after their planning cycle.",
        topics: ["Codex", "partnerships"],
      },
      {
        at: 38,
        type: "intro",
        notes: "Introduced me to David Kim on her team for the evaluation-infrastructure conversation.",
        topics: ["intro"],
      },
      {
        at: 16,
        type: "call",
        notes:
          "Thirty minutes on what a Codex integration would need. She wants a one-page architecture and a short demo video before their partner review.",
        topics: ["Codex", "partnerships"],
        actionItems: ["Send the one-page retrieval architecture", "Record a 3-minute demo video"],
      },
    ],
    followUpInDays: -12,
    reminder: {
      title: "Send Sarah the retrieval write-up",
      description: "She asked for a one-pager after the AWS Summit conversation.",
      inDays: -12,
    },
    standing:
      "Warm and active. She is waiting on the one-page architecture and a demo video before the Codex partner review — the follow-up is 12 days overdue.",
    history: [
      ["OpenAI", "Partnerships Lead", 2024, null],
      ["Stripe", "Product Manager, Infrastructure", 2020, 2024],
      ["Google", "Associate Product Manager", 2018, 2020],
    ],
    education: [["Stanford University", "Computer Science", 2014, 2018]],
  },
  {
    fullName: "Marcus Webb",
    firstName: "Marcus",
    lastName: "Webb",
    title: "Engineering Lead",
    company: "Linear",
    location: "San Francisco, CA",
    closeness: 3,
    howMet: "Introduced by Sarah Chen",
    metContext: "Coffee near their office",
    metDaysAgo: 21,
    // Marcus is one of the people named on the landing page (Megrez in the constellation
    // figure, "Coffee chat, 3 weeks ago · Drifting" in the reminders visual). No follow-up
    // on purpose: a scheduled one is exactly what would stop him reading as drifting.
    notes: "Owes me a look at their onboarding flow.",
    keyFacts: ["Introduced by Sarah Chen", "Hiring two senior engineers this quarter"],
    sharedInterests: ["developer tooling", "hiring"],
    tags: ["Engineering"],
    touches: [
      {
        at: 21,
        type: "in_person",
        notes:
          "Coffee with Marcus. They are hiring two senior engineers this quarter and asked whether I knew anyone. Offered to look at their onboarding flow.",
        topics: ["hiring", "onboarding"],
        actionItems: ["Send Marcus two engineer referrals"],
      },
    ],
    standing: "Drifting — one good coffee three weeks ago and nothing since. A referral would restart it.",
    history: [
      ["Linear", "Engineering Lead", 2023, null],
      ["Heroku", "Senior Software Engineer", 2018, 2023],
    ],
    education: [["University of Washington", "Computer Engineering", 2012, 2016]],
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
        type: "linkedin_message",
        direction: "in",
        notes:
          "First LinkedIn message about the payments infra team. Asked for my resume and what I'm optimising for.",
      },
      {
        at: 89,
        type: "linkedin_message",
        direction: "out",
        notes: "Replied with my resume and said I'm optimising for infra depth over title.",
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
    standing: "Healthy. Headcount reopens in January; check in before the cycle starts.",
    history: [
      ["Stripe", "Technical Recruiter", 2022, null],
      ["Hired", "Talent Partner", 2019, 2022],
    ],
    education: [["NYU", "Psychology", 2013, 2017]],
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
        type: "event",
        notes:
          "Met at the AWS Summit afterparty through Sarah. Long conversation about agent evaluation — she runs a homegrown harness and offered to share the design.",
        topics: ["agents", "evals", "AWS Summit"],
      },
      {
        at: 35,
        type: "call",
        notes: "She walked me through her eval harness. Golden sets per workflow, graded weekly.",
        topics: ["evals"],
      },
      {
        at: 21,
        type: "message",
        notes: "Swapped links about eval tooling. She's still planning to write the post.",
      },
    ],
    followUpInDays: 21,
    standing: "Close and reciprocal. Nothing owed either way; next natural touch is her eval post.",
    history: [
      ["Notion", "Founding Engineer, AI", 2023, null],
      ["Airtable", "Software Engineer", 2019, 2023],
    ],
    education: [["Carnegie Mellon University", "Computer Science", 2015, 2019]],
  },
  {
    fullName: "Dr. Elena Vasquez",
    firstName: "Elena",
    lastName: "Vasquez",
    title: "Professor of Computer Science",
    school: "UNC Chapel Hill",
    company: "UNC Chapel Hill",
    location: "Chapel Hill, NC",
    closeness: 5,
    priority: 2,
    howMet: "Taught my systems course; kept in touch after graduation",
    metDaysAgo: 400,
    notes:
      "Runs the distributed systems lab. Always worth talking to before a design decision. Suggested two students who might want to intern.",
    keyFacts: ["Runs the distributed systems lab at UNC", "Knows the Innovate Carolina staff"],
    tags: ["UNC", "Mentor"],
    touches: [
      {
        at: 400,
        type: "note",
        notes: "Took her distributed systems course. Stayed after lectures most weeks.",
        topics: ["UNC"],
      },
      {
        at: 250,
        type: "email",
        notes: "Sent her the first Orbit prototype. She replied with a page of questions about consistency.",
        topics: ["architecture"],
      },
      {
        at: 120,
        type: "meeting",
        notes:
          "Coffee on campus. Walked her through Orbit's data model; she pushed back on storing derived scores and was right.",
        topics: ["architecture", "UNC"],
      },
      {
        at: 75,
        type: "intro",
        notes: "Introduced me to James Okafor at the UNC founders dinner.",
        topics: ["fundraising", "intro"],
      },
      {
        at: 18,
        type: "email",
        notes:
          "She sent two student names for a possible internship and asked how the showcase prep is going.",
        topics: ["UNC", "hiring"],
        actionItems: ["Reply about the two intern candidates"],
      },
    ],
    followUpInDays: 5,
    reminder: {
      title: "Reply to Elena about the two students",
      description: "She sent names for a possible internship.",
      inDays: 2,
    },
    standing:
      "Your closest mentor. She is waiting on a reply about the two intern candidates she sent.",
    history: [
      ["UNC Chapel Hill", "Professor of Computer Science", 2015, null],
      ["Microsoft Research", "Researcher", 2010, 2015],
    ],
    education: [["MIT", "PhD, Electrical Engineering and Computer Science", 2004, 2010]],
  },
  {
    fullName: "James Okafor",
    firstName: "James",
    lastName: "Okafor",
    title: "Partner",
    company: "Bellwether Ventures",
    location: "New York, NY",
    email: "james@bellwether.example",
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
        actionItems: ["Add James to the monthly investor update"],
      },
      {
        at: 48,
        type: "intro",
        notes: "Introduced me to Grace Whitfield, an angel in Durham.",
        topics: ["fundraising", "intro"],
      },
    ],
    followUpInDays: -4,
    reminder: {
      title: "Add James to the monthly update",
      description: "He asked to be on the list at the UNC founders dinner.",
      inDays: -4,
      list: "Fundraising",
    },
    standing:
      "Promising investor relationship. He asked for the monthly update — sending it is 4 days overdue.",
    history: [
      ["Bellwether Ventures", "Partner", 2021, null],
      ["GitHub", "Director of Product", 2016, 2021],
    ],
    education: [["Harvard Business School", "MBA", 2014, 2016]],
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
        at: 900,
        type: "note",
        notes: "Joined the billing team together. She owned the invoicing roadmap.",
      },
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
    standing: "Steady old friendship. She is hiring a PM — a referral would be welcome.",
    history: [
      ["Google", "Senior Product Manager, Cloud DevEx", 2022, null],
      ["Braintree", "Product Manager, Billing", 2018, 2022],
    ],
    education: [["University of Michigan", "Economics", 2012, 2016]],
  },
  {
    fullName: "Tom Bennett",
    firstName: "Tom",
    lastName: "Bennett",
    title: "Staff Software Engineer",
    company: "Stripe",
    location: "Remote",
    // High closeness, no follow-up scheduled, 96 days quiet: exactly what the dashboard's
    // "Suggested outreach" queue is built to surface.
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
    standing: "Close but gone quiet — 96 days since the last call. Worth a check-in.",
    history: [
      ["Stripe", "Staff Software Engineer, API Platform", 2019, null],
      ["Twilio", "Software Engineer", 2015, 2019],
    ],
    education: [["University of Waterloo", "Software Engineering", 2010, 2015]],
  },
  {
    fullName: "Nina Petrova",
    firstName: "Nina",
    lastName: "Petrova",
    title: "Co-founder & CEO",
    company: "Lumen Health",
    location: "Boston, MA",
    closeness: 5,
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
        at: 101,
        type: "call",
        notes: "Talked me through structuring the first engineering offer. Equity over salary, but not by much.",
        topics: ["hiring"],
      },
      {
        at: 40,
        type: "in_person",
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
    standing: "Your closest founder relationship. Nothing outstanding; she liked the new positioning.",
    history: [
      ["Lumen Health", "Co-founder & CEO", 2025, null],
      ["Carebridge", "Co-founder & CEO (acquired)", 2019, 2024],
      ["McKinsey & Company", "Associate", 2016, 2019],
    ],
    education: [["Yale University", "Molecular Biology", 2012, 2016]],
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
    standing: "New. He asked to be pinged after a few weeks — that time has come.",
    history: [
      ["OpenAI", "Engineering Manager, Applied", 2023, null],
      ["Meta", "Software Engineer, ML Infra", 2018, 2023],
    ],
    education: [["UC Berkeley", "Electrical Engineering", 2014, 2018]],
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
        type: "event",
        notes: "Met after her panel at the design systems meetup. Swapped contacts.",
      },
      {
        at: 140,
        type: "intro",
        notes: "Introduced me to Sofia Marchetti for a landing-page critique.",
        topics: ["intro", "design"],
      },
    ],
    standing: "Light but friendly. She made a good intro; a thank-you would be timely.",
    history: [
      ["Figma", "Director of Talent", 2021, null],
      ["Dropbox", "Design Recruiting Lead", 2017, 2021],
    ],
    education: [["Howard University", "Communications", 2009, 2013]],
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
        type: "event",
        notes:
          "Judged his HackNC project. Retrieval over course notes, shipped in a weekend, and he could explain every choice.",
        topics: ["HackNC", "UNC"],
        actionItems: ["Send Ben the internship brief"],
      },
    ],
    followUpInDays: -20,
    standing: "A strong intern candidate you promised to follow up with — 20 days overdue.",
    history: [["Orbit (HackNC project)", "Builder", 2026, null]],
    education: [["UNC Chapel Hill", "Computer Science", 2023, 2027]],
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
    standing: "Generous design ally. Two of her six fixes are still unshipped.",
    history: [
      ["Figma", "Design Lead", 2022, null],
      ["Airbnb", "Senior Product Designer", 2017, 2022],
    ],
    education: [["Rhode Island School of Design", "Graphic Design", 2011, 2015]],
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
    standing: "Dormant — one great hallway conversation almost a year ago.",
    history: [
      ["Google", "Head of Platform, Zurich", 2020, null],
      ["Spotify", "Staff Engineer", 2015, 2020],
    ],
    education: [["ETH Zurich", "Computer Science", 2009, 2014]],
  },
  {
    fullName: "Maya Thompson",
    firstName: "Maya",
    lastName: "Thompson",
    title: "Program Director",
    company: "Innovate Carolina",
    school: "UNC Chapel Hill",
    location: "Chapel Hill, NC",
    email: "maya.thompson@example.com",
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
        at: 60,
        type: "email",
        notes: "Accepted into the fall cohort. She sent the programme calendar.",
        topics: ["UNC"],
      },
      {
        at: 27,
        type: "email",
        notes: "Confirmed the showcase slot and sent the logistics.",
        topics: ["UNC", "showcase"],
        actionItems: ["Send Maya the showcase one-liner"],
      },
    ],
    followUpInDays: 3,
    reminder: {
      title: "Send Maya the showcase one-liner",
      description: "She needs the description for the programme by Friday.",
      inDays: 1,
    },
    standing: "Active. She needs the showcase one-liner by Friday.",
    history: [
      ["Innovate Carolina", "Program Director", 2021, null],
      ["Research Triangle Foundation", "Program Manager", 2016, 2021],
    ],
    education: [["UNC Chapel Hill", "Public Policy", 2010, 2014]],
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
      { at: 55, type: "in_person", notes: "Dinner with Priya's team. Talked about Postgres indexing." },
    ],
    standing: "Acquaintance through Priya. The person to ask about Postgres.",
    history: [
      ["Notion", "Senior Backend Engineer", 2022, null],
      ["Shopify", "Backend Engineer", 2018, 2022],
    ],
    education: [["University of Toronto", "Computer Science", 2014, 2018]],
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
        actionItems: ["Send Grace the Q3 update"],
      },
    ],
    followUpInDays: -7,
    reminder: {
      title: "Send Grace the quarterly update",
      description: "She decides fast and asked for a short update every quarter.",
      inDays: -7,
      list: "Fundraising",
    },
    standing: "Warm angel prospect. The quarterly update she asked for is a week late.",
    history: [
      ["Independent", "Angel Investor", 2020, null],
      ["Red Hat", "VP Engineering", 2008, 2020],
    ],
    education: [["Duke University", "Computer Science", 1998, 2002]],
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
    standing: "Occasional peer. Last spoke four months ago about founder-led sales.",
    history: [
      ["Tidepool Analytics", "Founder", 2024, null],
      ["Tesla", "Manufacturing Data Engineer", 2019, 2024],
    ],
    education: [["UT Austin", "Industrial Engineering", 2015, 2019]],
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
    standing: "A learning relationship. Last exchange was three papers on eval design.",
    history: [
      ["Anthropic", "Research Scientist, Interpretability", 2023, null],
      ["DeepMind", "Research Engineer", 2020, 2023],
    ],
    education: [["University of Tokyo", "PhD, Machine Learning", 2015, 2020]],
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
    touches: [{ at: 230, type: "event", notes: "Alumni mixer. She offered two introductions." }],
    followUpInDays: -31,
    standing: "Overdue by a month. She offered two alumni intros you never took her up on.",
    history: [["UNC Chapel Hill", "Alumni Relations Lead", 2019, null]],
    education: [["UNC Chapel Hill", "Communications", 2011, 2015]],
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
    standing: "Weak tie via Aisha. The contact for anything search-infrastructure.",
    history: [
      ["Google", "Engineering Manager, Search Infra", 2021, null],
      ["Elastic", "Senior Engineer", 2016, 2021],
    ],
    education: [["Rutgers University", "Computer Science", 2010, 2014]],
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
      {
        at: 30,
        type: "linkedin_message",
        direction: "in",
        notes: "Intro from Marcus. She offered a walkthrough of activation metrics.",
      },
      {
        at: 29,
        type: "linkedin_message",
        direction: "out",
        notes: "Accepted gladly and proposed a couple of times next week.",
      },
    ],
    followUpInDays: 7,
    standing: "New and promising. Book the activation-metrics walkthrough she offered.",
    history: [
      ["Stripe", "Product Manager, Onboarding", 2023, null],
      ["Monzo", "Associate Product Manager", 2020, 2023],
    ],
    education: [["London School of Economics", "Management", 2016, 2019]],
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
      { at: 95, type: "event", notes: "Founders panel green room. Long talk about hiring." },
      { at: 58, type: "call", notes: "He talked me out of a bad first hire." },
    ],
    standing: "Trusted peer on hiring. Last call saved you from a bad first hire.",
    history: [
      ["Northlight Robotics", "Founder & CTO", 2022, null],
      ["Boston Dynamics", "Robotics Engineer", 2016, 2022],
    ],
    education: [["Carnegie Mellon University", "Robotics", 2012, 2016]],
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
    standing: "Useful once Bellwether invests — she shares a portfolio candidate list.",
    history: [
      ["Bellwether Ventures", "Head of Talent", 2022, null],
      ["Andreessen Horowitz", "Talent Partner", 2018, 2022],
    ],
    education: [["Columbia University", "Sociology", 2012, 2016]],
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
    standing: "Helpful alum. Show him the prompt changes his review led to.",
    history: [
      ["Anthropic", "Software Engineer, Inference", 2024, null],
      ["Epic Games", "Software Engineer", 2022, 2024],
    ],
    education: [["UNC Chapel Hill", "Computer Science", 2018, 2022]],
  },
];

/** Goals shown on the dashboard and fed to outreach drafts and chat. */
export const DEMO_GOALS = [
  "Raise a pre-seed round from Triangle and developer-tools investors",
  "Hire a founding engineer who has shipped retrieval systems",
  "Land a developer-tools partnership with an AI lab",
];
