/**
 * The extended demo workspace's additions to the hand-written cast in `network.ts`.
 *
 * `network.ts` is also the fixture `scripts/smoke-behavior-golden.ts` records against, so it
 * stays exactly as it is and everything the extended workspace adds lives here: more of each
 * relationship's history, the capture sessions that logged several people at once, and the
 * opportunities those conversations surfaced.
 *
 * Every addition is written to fit the person's `standing` line. Someone who reads as
 * drifting or dormant gets older history, never a recent touch that would contradict it —
 * Marcus Webb, who the landing page shows as drifting, gets nothing at all.
 *
 * Full names in notes are deliberate: the seeder links any cast member named in a note as a
 * mention, which is what makes the network read as connected rather than a list.
 *
 * Pure data. The writer is `seed.ts`.
 */
import type { OpportunityKind } from "@/db/schema";
import type { DemoTouch } from "@/lib/demo-data/network";

export const EXTRA_TOUCHES: Record<string, DemoTouch[]> = {
  "Sarah Chen": [
    {
      at: 30,
      type: "meeting",
      notes:
        "Google Meet with Sarah to scope the Codex integration. She wants retrieval latency under 300ms at p95 and a clear story on how Orbit handles stale context.",
      topics: ["Codex", "latency"],
    },
    {
      at: 24,
      type: "email",
      notes: "Sent her the AWS Summit talk slides she asked about and a short note on our p95 numbers.",
      topics: ["AI infrastructure"],
    },
    {
      at: 9,
      type: "email",
      notes: "She nudged: the partner review moved up a week and the one-pager is the last missing piece.",
      topics: ["Codex", "partnerships"],
    },
  ],
  "Marcus Lee": [
    {
      at: 60,
      type: "email",
      notes: "Sent over the payments infrastructure job description and the team's interview loop.",
      topics: ["hiring", "payments"],
    },
    {
      at: 31,
      type: "intro",
      notes: "Introduced me to Fatima Nasser on the activation team — said she'd be the right person for metrics questions.",
      topics: ["intro"],
    },
    {
      at: 12,
      type: "linkedin_message",
      direction: "in",
      notes: "Heads up that the January requisition is being written. He'll send it the day it's posted.",
      topics: ["hiring"],
    },
  ],
  "Priya Nair": [
    {
      at: 55,
      type: "in_person",
      notes:
        "Dinner with Priya's team at their offsite. Sat next to Hassan Ali, who knows more about Postgres indexing than anyone I've met.",
      topics: ["Postgres", "team"],
    },
    {
      at: 47,
      type: "email",
      notes: "She sent her eval rubric template — five graded dimensions, one golden set per workflow.",
      topics: ["agent evaluation"],
    },
    {
      at: 8,
      type: "call",
      notes:
        "Compared notes on agent evals. She offered to review Orbit's chat grounding eval set and suggested looping in Yuki Tanaka for the research side.",
      topics: ["agent evaluation", "chat grounding"],
    },
  ],
  "Dr. Elena Vasquez": [
    {
      at: 330,
      type: "meeting",
      notes: "Office hours. She told me to stop polishing and put Orbit in front of ten people.",
      topics: ["mentorship"],
    },
    {
      at: 180,
      type: "email",
      notes:
        "She recommended applying to the Innovate Carolina venture program and copied Maya Thompson, who runs it.",
      topics: ["Innovate Carolina", "intro"],
    },
    {
      at: 45,
      type: "event",
      notes:
        "Judged HackNC together. She flagged Ben Carter's retrieval project as the one to watch — she was right.",
      topics: ["HackNC", "students"],
    },
  ],
  "James Okafor": [
    {
      at: 73,
      type: "email",
      notes: "Sent the deck he asked for at dinner. He came back with three sharp questions on retention cohorts.",
      topics: ["fundraising", "retention"],
    },
    {
      at: 62,
      type: "call",
      notes:
        "Forty-five minutes on cohort retention. Wants a monthly update and offered time with Amara Diallo on their talent team once we're hiring.",
      topics: ["fundraising", "retention"],
      actionItems: ["Add James to the monthly investor update"],
    },
    {
      at: 34,
      type: "email",
      notes: "Sent the August update. He replied the same evening — liked the activation numbers.",
      topics: ["investor update"],
    },
  ],
  "Aisha Rahman": [
    {
      at: 600,
      type: "call",
      notes: "Caught up after she moved to Google Cloud. She's happier and already running the free-tier roadmap.",
      topics: ["career"],
    },
    {
      at: 300,
      type: "email",
      notes: "She introduced me to Chris Nowak for anything search-infrastructure.",
      topics: ["intro", "search"],
    },
    {
      at: 20,
      type: "message",
      notes: "She shared the PM job description — senior, platform-facing, Seattle or remote.",
      topics: ["hiring"],
    },
  ],
  "Tom Bennett": [
    {
      at: 230,
      type: "email",
      notes: "He sent a patch implementing date-based API versions. Cleaner than what I had.",
      topics: ["API versioning", "open source"],
    },
    {
      at: 180,
      type: "call",
      notes: "Paired on the webhook retry logic for an hour. Exponential backoff with jitter, capped at six tries.",
      topics: ["webhooks"],
    },
    {
      at: 130,
      type: "linkedin_message",
      direction: "out",
      notes: "Congratulated him on the Staff promotion at Stripe.",
    },
  ],
  "Nina Petrova": [
    {
      at: 125,
      type: "email",
      notes: "She sent her first-engineer scorecard. Four signals, weighted, with example answers.",
      topics: ["hiring"],
    },
    {
      at: 70,
      type: "call",
      notes: "Walked through pricing. She argued hard for one paid plan until we have fifty paying users.",
      topics: ["pricing"],
    },
    {
      at: 25,
      type: "call",
      notes: "Mock investor pitch. Ruthless on the market slide; kind on the demo.",
      topics: ["fundraising", "pitch"],
    },
  ],
  "David Kim": [
    {
      at: 37,
      type: "linkedin_message",
      direction: "out",
      notes: "Connected after Sarah Chen's intro and said I'd ping him once the write-up was ready.",
    },
  ],
  "Rachel Adeyemi": [
    {
      at: 160,
      type: "email",
      notes: "Thanked her for the panel. She sent the talent-brand deck Figma uses for recruiting.",
      topics: ["design", "hiring"],
    },
    {
      at: 90,
      type: "linkedin_message",
      direction: "in",
      notes: "She asked how the intro to Sofia Marchetti went.",
    },
  ],
  "Ben Carter": [
    {
      at: 44,
      type: "email",
      notes: "He sent his HackNC repo and resume. The retrieval code is genuinely good.",
      topics: ["internship"],
    },
    {
      at: 40,
      type: "linkedin_message",
      direction: "out",
      notes: "Said I'd connect him with Dr. Elena Vasquez about research credit for an internship.",
    },
  ],
  "Sofia Marchetti": [
    {
      at: 120,
      type: "email",
      notes: "Sent the Figma file; she replied with a Loom walking through the hierarchy problems.",
      topics: ["design"],
    },
    {
      at: 95,
      type: "call",
      notes: "Paired on onboarding empty states. Her rule: every empty state should teach one thing.",
      topics: ["design", "onboarding"],
    },
    {
      at: 30,
      type: "message",
      notes: "She asked whether the last two fixes shipped. Not yet.",
    },
  ],
  "Andre Silva": [
    {
      at: 318,
      type: "linkedin_message",
      direction: "out",
      notes: "Connected after his multi-region talk and thanked him for the hallway conversation.",
    },
  ],
  "Maya Thompson": [
    {
      at: 90,
      type: "meeting",
      notes: "Cohort pitch practice. She cut my intro from ninety seconds to twenty.",
      topics: ["pitch", "Innovate Carolina"],
    },
    {
      at: 14,
      type: "call",
      notes: "Dry run of the showcase demo. Trimmed it to five minutes and moved the constellation to the opening.",
      topics: ["showcase"],
    },
    {
      at: 6,
      type: "email",
      notes: "Reminder: the showcase one-liner is due Friday for the printed program.",
      topics: ["showcase"],
      actionItems: ["Send Maya the showcase one-liner"],
    },
  ],
  "Hassan Ali": [
    {
      at: 40,
      type: "message",
      notes: "He sent a gist on partial indexes for the interactions table.",
      topics: ["Postgres"],
    },
    {
      at: 18,
      type: "email",
      notes: "Thanked him — the timeline query dropped from 800ms to 40ms with his index.",
      topics: ["Postgres", "performance"],
    },
  ],
  "Grace Whitfield": [
    {
      at: 41,
      type: "email",
      notes: "Sent the deck. She asked for Q3 numbers before anything else.",
      topics: ["fundraising"],
    },
    {
      at: 26,
      type: "in_person",
      notes: "Coffee in Durham. Wants a quarterly update and plans to see the demo at the showcase.",
      topics: ["fundraising", "showcase"],
    },
  ],
  "Leo Fernandez": [
    {
      at: 170,
      type: "call",
      notes: "He shared his cold outbound sequence: three emails, one LinkedIn touch, then stop.",
      topics: ["sales"],
    },
    {
      at: 128,
      type: "email",
      notes: "Sent him my notes from our call on founder-led demos.",
      topics: ["sales"],
    },
  ],
  "Yuki Tanaka": [
    {
      at: 175,
      type: "message",
      notes: "Swapped notes after her first reading-group session on retrieval.",
      topics: ["retrieval"],
    },
    {
      at: 150,
      type: "note",
      notes: "She led the reading group on retrieval-augmented generation. Best session of the season.",
      topics: ["retrieval", "papers"],
    },
    {
      at: 120,
      type: "email",
      notes: "Sent her the Orbit eval sketch; two pages of notes back within a day.",
      topics: ["agent evaluation"],
    },
  ],
  "Olivia Brooks": [
    {
      at: 228,
      type: "email",
      notes: "She followed up with the alumni directory link and the two names she'd mentioned.",
      topics: ["alumni"],
    },
    {
      at: 200,
      type: "event",
      notes: "Brief hello at the homecoming alumni tailgate.",
      topics: ["alumni"],
    },
  ],
  "Chris Nowak": [
    {
      at: 290,
      type: "call",
      notes: "Twenty minutes on search infrastructure. He pointed me at hybrid BM25 plus vectors.",
      topics: ["search"],
    },
    {
      at: 150,
      type: "linkedin_message",
      direction: "in",
      notes: "He asked how the hybrid search experiment turned out.",
    },
  ],
  "Fatima Nasser": [
    {
      at: 28,
      type: "email",
      notes: "She sent a doc on how Stripe defines activation for self-serve accounts.",
      topics: ["activation metrics"],
    },
  ],
  "Daniel Osei": [
    {
      at: 80,
      type: "email",
      notes: "He sent the interview scorecard that caught his own bad hire.",
      topics: ["hiring"],
    },
    {
      at: 20,
      type: "message",
      notes: "Checked in on the founding-engineer search. Offered to sit in on a final round.",
      topics: ["hiring"],
    },
  ],
  "Amara Diallo": [
    {
      at: 50,
      type: "email",
      notes: "She explained how the Bellwether portfolio candidate list works and who gets access.",
      topics: ["hiring"],
    },
  ],
  "Victor Reyes": [
    {
      at: 60,
      type: "call",
      notes: "Alumni coffee over Zoom. Talked Anthropic's research culture and what makes a good eval.",
      topics: ["AI", "alumni"],
    },
    {
      at: 45,
      type: "email",
      notes: "Sent him Orbit's prompt set to review.",
      topics: ["prompting"],
    },
    {
      at: 10,
      type: "message",
      notes: "He asked to see the before-and-after of the prompt changes.",
      topics: ["prompting"],
    },
  ],
};

/** A concrete possibility a conversation surfaced, pinned to the touch that surfaced it. */
export type DemoOpportunity = {
  person: string;
  kind: OpportunityKind;
  label: string;
  status: "open" | "in_progress" | "landed";
  direction?: "they_offer" | "you_ask";
  /** Days ahead; negative is past due. */
  dueInDays?: number;
  excerpt: string;
};

export const DEMO_OPPORTUNITIES: DemoOpportunity[] = [
  {
    person: "Sarah Chen",
    kind: "collaboration",
    label: "Codex developer-tools integration",
    status: "in_progress",
    direction: "they_offer",
    dueInDays: 9,
    excerpt: "She wants a one-page architecture and a short demo video before their partner review.",
  },
  {
    person: "James Okafor",
    kind: "investor",
    label: "Bellwether pre-seed conversation",
    status: "open",
    direction: "you_ask",
    excerpt: "Wants the monthly update and asked good questions about retention rather than growth.",
  },
  {
    person: "Grace Whitfield",
    kind: "investor",
    label: "Angel check ahead of the showcase",
    status: "open",
    direction: "you_ask",
    dueInDays: 12,
    excerpt: "Plans to see the demo at the showcase.",
  },
  {
    person: "Marcus Lee",
    kind: "job",
    label: "Payments infrastructure role (January req)",
    status: "open",
    direction: "they_offer",
    dueInDays: 40,
    excerpt: "Headcount is frozen until January; he'll send the requisition the day it's posted.",
  },
  {
    person: "Dr. Elena Vasquez",
    kind: "internship",
    label: "Two student interns for the spring",
    status: "open",
    direction: "they_offer",
    dueInDays: 5,
    excerpt: "She sent two student names for a possible internship.",
  },
  {
    person: "Aisha Rahman",
    kind: "referral",
    label: "Refer a senior PM to Google Cloud",
    status: "open",
    direction: "you_ask",
    excerpt: "She's hiring a PM and asked if I knew anyone.",
  },
  {
    person: "Priya Nair",
    kind: "advice",
    label: "Review of Orbit's chat grounding eval set",
    status: "in_progress",
    direction: "they_offer",
    excerpt: "She offered to review Orbit's chat grounding eval set.",
  },
  {
    person: "Maya Thompson",
    kind: "speaker",
    label: "Five-minute demo slot at the Fall Showcase",
    status: "landed",
    direction: "they_offer",
    dueInDays: 12,
    excerpt: "Confirmed the showcase slot and sent the logistics.",
  },
  {
    person: "Daniel Osei",
    kind: "advice",
    label: "Sit in on a founding-engineer final round",
    status: "open",
    direction: "they_offer",
    excerpt: "Offered to sit in on a final round.",
  },
];

/**
 * Capture sessions: one note that logged several people at once. Each becomes a saved
 * `note_batches` row (the /capture history and its results page), one interaction per
 * participant pointing back at it, and mentions between everyone the note names.
 */
export type DemoCapture = {
  title: string;
  daysAgo: number;
  kind: "text" | "voice" | "calendar";
  text: string;
  participants: string[];
  interactionType: "meeting" | "in_person" | "event" | "call" | "note";
  topics: string[];
  /** Present when the capture was a recorded meeting (`/capture?mode=meeting`). */
  meeting?: {
    durationMin: number;
    summary: string;
    keyPoints: string[];
    decisions: string[];
    actionItems: { text: string; owner: string | null }[];
    openQuestions: { text: string; askedBy: string | null }[];
    transcript: { speaker: string; text: string }[];
  };
};

export const DEMO_CAPTURES: DemoCapture[] = [
  {
    title: "AWS Summit afterparty",
    daysAgo: 60,
    kind: "voice",
    text:
      "Great night at the AWS Summit afterparty. Sarah Chen introduced me to Priya Nair from Notion — Priya runs agent evaluation and has a golden-set harness I want to copy. Sarah and I kept talking inference costs; she wants a write-up on our retrieval setup. Follow up with both this week.",
    participants: ["Sarah Chen", "Priya Nair"],
    interactionType: "event",
    topics: ["AWS Summit", "agent evaluation"],
  },
  {
    title: "Bellwether partner meeting",
    daysAgo: 70,
    kind: "text",
    text:
      "Met James Okafor and Amara Diallo at Bellwether's office. James went deep on retention cohorts; Amara walked through how their portfolio candidate list works. James wants monthly updates. Amara will share the list once we close.",
    participants: ["James Okafor", "Amara Diallo"],
    interactionType: "meeting",
    topics: ["fundraising", "hiring"],
  },
  {
    title: "Showcase prep with Maya and Grace",
    daysAgo: 13,
    kind: "calendar",
    text:
      "Showcase prep call with Maya Thompson and Grace Whitfield. Maya confirmed the five-minute slot; Grace will be in the room and wants the Q3 numbers beforehand. Open with the constellation, end on the chat demo.",
    participants: ["Maya Thompson", "Grace Whitfield"],
    interactionType: "call",
    topics: ["showcase", "fundraising"],
  },
  {
    title: "Founding engineer hiring sync",
    daysAgo: 4,
    kind: "voice",
    text:
      "Hiring sync with Nina Petrova and Daniel Osei. Both think we should hire for ownership over pedigree. Daniel will sit in on the final round; Nina is sending her offer template. Ask Victor Reyes if he knows anyone from the UNC alumni pool.",
    participants: ["Nina Petrova", "Daniel Osei"],
    interactionType: "meeting",
    topics: ["hiring", "founding engineer"],
    meeting: {
      durationMin: 34,
      summary:
        "Nina and Daniel agreed the founding-engineer hire should optimise for ownership over pedigree. Daniel will join the final round, Nina will share her offer template, and Victor Reyes may know strong candidates from the UNC alumni pool.",
      keyPoints: [
        "Hire for ownership and speed over big-company pedigree",
        "Run a paid one-day work trial instead of a take-home",
        "Equity-heavy offer, but keep salary within 15% of market",
      ],
      decisions: ["Use a paid work trial for the final round", "Daniel Osei joins the final interview"],
      actionItems: [
        { text: "Send the offer template", owner: "Nina Petrova" },
        { text: "Block time for the final-round interview", owner: "Daniel Osei" },
        { text: "Ask Victor Reyes for UNC alumni candidates", owner: null },
      ],
      openQuestions: [{ text: "Is a four-day work trial too much to ask of someone employed?", askedBy: "Nina Petrova" }],
      transcript: [
        { speaker: "You", text: "Thanks for making time. I want to lock the process for the founding engineer role this week." },
        { speaker: "Nina Petrova", text: "The one thing I'd push on: hire for ownership. You want someone who ships without being asked." },
        { speaker: "Daniel Osei", text: "Agreed. My bad hire looked perfect on paper — big-company pedigree, never owned anything end to end." },
        { speaker: "You", text: "So the take-home goes, and we do a paid work trial instead?" },
        { speaker: "Daniel Osei", text: "One day, paid, on a real problem. I'm happy to sit in on the final round." },
        { speaker: "Nina Petrova", text: "I'll send you my offer template. Equity-heavy, but keep salary within fifteen percent of market." },
        { speaker: "You", text: "Great. I'll also ask Victor Reyes whether he knows anyone from the UNC alumni pool." },
      ],
    },
  },
  {
    title: "Coffee with Hassan and Priya",
    daysAgo: 16,
    kind: "text",
    text:
      "Coffee with Hassan Ali and Priya Nair while they were in town. Hassan's partial index cut the timeline query from 800ms to 40ms. Priya wants to co-write a post on evals for relationship data.",
    participants: ["Hassan Ali", "Priya Nair"],
    interactionType: "in_person",
    topics: ["Postgres", "agent evaluation"],
  },
];
