/**
 * The waitlist demo's made-up network. Pure data, no imports: the demo, its tour and the
 * smoke test all read it, and nothing here may reach the database or the real app.
 *
 * A broad professional mix on purpose — old colleagues, a mentor, a recruiter, a prospect,
 * a founder friend — so any visitor recognises someone. Companies repeat so the
 * Constellation has figures to draw: Figma ×3, Stripe ×3, Deloitte ×2, Michigan alumni ×3.
 * Maya Okafor carries the tour's story; keep her suggestion, promise and Figma star intact.
 */

export type TimelineType = "Email" | "Meeting" | "Call" | "LinkedIn" | "In person" | "Note";
export type TimelineSource = "Gmail" | "Google Calendar" | "LinkedIn" | "You";

export type TimelineEntry = {
  id: string;
  type: TimelineType;
  daysAgo: number;
  note: string;
  source: TimelineSource;
};

export type ClusterId = "figma" | "stripe" | "deloitte" | "michigan";

export type DemoPerson = {
  id: string;
  name: string;
  /** Avatar hue, 0–360. Avatars are initials on a gradient disc — no photos. */
  hue: number;
  title: string;
  company: string;
  city: string;
  /** 0–100, what the closeness chip shows. */
  closeness: number;
  lastTouchDays: number;
  /** Days until the follow-up is due; negative is overdue; null is none set. */
  followUpDays: number | null;
  followUpLabel?: string;
  howMet: string;
  standing: string;
  nextStep: string;
  /** Something you told them you'd do — what "What did I promise…?" answers. */
  promise?: { text: string; when: string; source: TimelineSource };
  tags: string[];
  timeline: TimelineEntry[];
  cluster: ClusterId | null;
  /** Position on the Constellation's 800×480 sky. */
  star: { x: number; y: number };
};

export const CLUSTERS: Record<ClusterId, { label: string; kind: "company" | "school"; labelAt: { x: number; y: number } }> = {
  figma: { label: "Figma", kind: "company", labelAt: { x: 150, y: 70 } },
  stripe: { label: "Stripe", kind: "company", labelAt: { x: 610, y: 66 } },
  deloitte: { label: "Deloitte", kind: "company", labelAt: { x: 640, y: 432 } },
  michigan: { label: "University of Michigan", kind: "school", labelAt: { x: 128, y: 462 } },
};

/** Stars joined into each figure, in drawing order. */
export const CLUSTER_CHAINS: Record<ClusterId, string[]> = {
  figma: ["maya", "daniel", "priya", "maya"],
  stripe: ["elena", "marcus", "aisha"],
  deloitte: ["tom", "sofia"],
  michigan: ["jordan", "hannah", "ben"],
};

export const DEMO_PEOPLE: DemoPerson[] = [
  {
    id: "maya",
    name: "Maya Okafor",
    hue: 12,
    title: "Product Lead",
    company: "Figma",
    city: "San Francisco",
    closeness: 71,
    lastTouchDays: 46,
    followUpDays: null,
    howMet: "Worked together at Deloitte Digital, 2019–2022",
    standing:
      "She's building out a new product team at Figma and asked how you ran discovery on the Atlas project.",
    nextStep: "Send her the deck from the design offsite and suggest a call.",
    promise: {
      text: "send her the deck from the design offsite",
      when: "over coffee on Aug 8",
      source: "Google Calendar",
    },
    tags: ["former colleague", "product", "hiring"],
    timeline: [
      { id: "m1", type: "Email", daysAgo: 46, note: "“Would love that offsite deck when you get a sec!”", source: "Gmail" },
      { id: "m2", type: "Meeting", daysAgo: 50, note: "Coffee at Sightglass — her new team, discovery rituals, the offsite deck", source: "Google Calendar" },
      { id: "m3", type: "LinkedIn", daysAgo: 74, note: "Congratulated her on the move to Product Lead", source: "LinkedIn" },
      { id: "m4", type: "Call", daysAgo: 131, note: "Caught up on the Figma role before she accepted", source: "Google Calendar" },
    ],
    cluster: "figma",
    star: { x: 178, y: 118 },
  },
  {
    id: "daniel",
    name: "Daniel Kim",
    hue: 205,
    title: "Design Engineer",
    company: "Figma",
    city: "New York",
    closeness: 58,
    lastTouchDays: 19,
    followUpDays: 9,
    followUpLabel: "Share the prototype feedback",
    howMet: "Config conference, 2023",
    standing: "Sent you an early prototype of a plugin he's building for design tokens.",
    nextStep: "Reply with feedback on the token plugin.",
    promise: { text: "give feedback on his design-token plugin", when: "in an email thread on Sep 6", source: "Gmail" },
    tags: ["design", "conference"],
    timeline: [
      { id: "d1", type: "Email", daysAgo: 19, note: "Sent a Loom of the token plugin prototype", source: "Gmail" },
      { id: "d2", type: "In person", daysAgo: 120, note: "Met at Config after the systems talk", source: "You" },
    ],
    cluster: "figma",
    star: { x: 250, y: 168 },
  },
  {
    id: "priya",
    name: "Priya Shah",
    hue: 280,
    title: "Head of Research",
    company: "Figma",
    city: "Seattle",
    closeness: 44,
    lastTouchDays: 88,
    followUpDays: null,
    howMet: "Introduced by Maya Okafor",
    standing: "Runs research at Figma; open to comparing notes on interview synthesis.",
    nextStep: "Ask Maya for a refresher intro before reaching out.",
    tags: ["research", "intro"],
    timeline: [
      { id: "p1", type: "Meeting", daysAgo: 88, note: "Intro call via Maya — research ops, synthesis tools", source: "Google Calendar" },
    ],
    cluster: "figma",
    star: { x: 112, y: 178 },
  },
  {
    id: "elena",
    name: "Elena Rossi",
    hue: 340,
    title: "Partnerships Manager",
    company: "Stripe",
    city: "Chicago",
    closeness: 83,
    lastTouchDays: 6,
    followUpDays: -3,
    followUpLabel: "Intro Elena to Grace Liu",
    howMet: "Michigan Ross MBA study group",
    standing: "Leads logistics partnerships at Stripe and asked for founders scaling ops.",
    nextStep: "Make the intro to Grace Liu at Northwind.",
    promise: { text: "introduce her to Grace Liu at Northwind", when: "on a call on Sep 19", source: "Google Calendar" },
    tags: ["partnerships", "fintech", "close friend"],
    timeline: [
      { id: "e1", type: "Call", daysAgo: 6, note: "Weekly-ish catch-up — she wants logistics founders", source: "Google Calendar" },
      { id: "e2", type: "Email", daysAgo: 22, note: "Shared the Stripe partner program one-pager", source: "Gmail" },
      { id: "e3", type: "In person", daysAgo: 60, note: "Dinner in Chicago", source: "You" },
    ],
    cluster: "stripe",
    star: { x: 572, y: 110 },
  },
  {
    id: "marcus",
    name: "Marcus Webb",
    hue: 160,
    title: "Staff Engineer",
    company: "Stripe",
    city: "Seattle",
    closeness: 62,
    lastTouchDays: 34,
    followUpDays: 14,
    followUpLabel: "Ask about the payments reliability talk",
    howMet: "Hackathon teammate, 2018",
    standing: "Gave a talk on payments reliability; happy to review system designs.",
    nextStep: "Ask for his slides for the reliability review.",
    tags: ["engineering", "mentor-ish"],
    timeline: [
      { id: "mw1", type: "LinkedIn", daysAgo: 34, note: "Shared his reliability talk; you replied", source: "LinkedIn" },
      { id: "mw2", type: "Call", daysAgo: 92, note: "Architecture sounding board for the Atlas rewrite", source: "Google Calendar" },
    ],
    cluster: "stripe",
    star: { x: 648, y: 150 },
  },
  {
    id: "aisha",
    name: "Aisha Bello",
    hue: 40,
    title: "Technical Recruiter",
    company: "Stripe",
    city: "Remote",
    closeness: 39,
    lastTouchDays: 27,
    followUpDays: null,
    howMet: "Reached out about a Staff PM role",
    standing: "Recruiting for Stripe's platform PM team; said to ping her in the new year.",
    nextStep: "Check in about platform PM openings in January.",
    tags: ["recruiter", "job search"],
    timeline: [
      { id: "a1", type: "Email", daysAgo: 27, note: "“Let's reconnect in January when headcount lands.”", source: "Gmail" },
      { id: "a2", type: "LinkedIn", daysAgo: 30, note: "Recruiter InMail about Staff PM, Platform", source: "LinkedIn" },
    ],
    cluster: "stripe",
    star: { x: 700, y: 96 },
  },
  {
    id: "tom",
    name: "Tom Brennan",
    hue: 220,
    title: "Senior Manager",
    company: "Deloitte",
    city: "Boston",
    closeness: 66,
    lastTouchDays: 12,
    followUpDays: null,
    howMet: "Your first manager at Deloitte",
    standing: "Just moved into the AI strategy practice and messaged you about it.",
    nextStep: "Reply to his LinkedIn message and congratulate him.",
    tags: ["former manager", "consulting"],
    timeline: [
      { id: "t1", type: "LinkedIn", daysAgo: 12, note: "“Big news — moving to the AI strategy practice. Coffee soon?”", source: "LinkedIn" },
      { id: "t2", type: "Email", daysAgo: 140, note: "Holiday note and a photo from the old team", source: "Gmail" },
    ],
    cluster: "deloitte",
    star: { x: 612, y: 382 },
  },
  {
    id: "sofia",
    name: "Sofia Martinez",
    hue: 300,
    title: "Consultant",
    company: "Deloitte",
    city: "Austin",
    closeness: 48,
    lastTouchDays: 64,
    followUpDays: null,
    howMet: "Same Deloitte start class",
    standing: "Thinking about leaving consulting for product; asked for advice.",
    nextStep: "Send her the product-transition reading list.",
    tags: ["consulting", "career advice"],
    timeline: [
      { id: "s1", type: "Call", daysAgo: 64, note: "Talked through moving from consulting into product", source: "Google Calendar" },
    ],
    cluster: "deloitte",
    star: { x: 690, y: 344 },
  },
  {
    id: "jordan",
    name: "Jordan Lee",
    hue: 100,
    title: "Founder & CEO",
    company: "Loop Health",
    city: "Denver",
    closeness: 88,
    lastTouchDays: 3,
    followUpDays: 5,
    followUpLabel: "Review Loop's pitch deck",
    howMet: "Roommates at Michigan",
    standing: "Raising a seed round for Loop Health; you've been advising on product.",
    nextStep: "Send comments on the pitch deck before Friday.",
    promise: { text: "review Loop's pitch deck before Friday", when: "on a call three days ago", source: "Google Calendar" },
    tags: ["founder", "friend", "advising"],
    timeline: [
      { id: "j1", type: "Call", daysAgo: 3, note: "Seed round prep — you'll review the deck", source: "Google Calendar" },
      { id: "j2", type: "Call", daysAgo: 11, note: "Roadmap priorities for the pilot clinics", source: "Google Calendar" },
      { id: "j3", type: "Call", daysAgo: 24, note: "First advisory session", source: "Google Calendar" },
    ],
    cluster: "michigan",
    star: { x: 196, y: 372 },
  },
  {
    id: "hannah",
    name: "Hannah Cole",
    hue: 250,
    title: "VP Engineering",
    company: "Notion",
    city: "San Francisco",
    closeness: 76,
    lastTouchDays: 21,
    followUpDays: 2,
    followUpLabel: "Monthly mentoring call",
    howMet: "Michigan alumni mentoring program",
    standing: "Your mentor for three years; last call was about managing managers.",
    nextStep: "Book this month's mentoring call.",
    tags: ["mentor", "leadership"],
    timeline: [
      { id: "h1", type: "Meeting", daysAgo: 21, note: "Mentoring — managing managers, skip-levels", source: "Google Calendar" },
      { id: "h2", type: "Meeting", daysAgo: 52, note: "Mentoring — planning a reorg", source: "Google Calendar" },
    ],
    cluster: "michigan",
    star: { x: 118, y: 330 },
  },
  {
    id: "ben",
    name: "Ben Carter",
    hue: 180,
    title: "Product Manager",
    company: "Spotify",
    city: "New York",
    closeness: 52,
    lastTouchDays: 41,
    followUpDays: null,
    howMet: "Michigan product club",
    standing: "Working on podcast discovery; mentioned Spotify is hiring senior PMs.",
    nextStep: "Ask about the senior PM opening.",
    tags: ["product", "alumni"],
    timeline: [
      { id: "b1", type: "LinkedIn", daysAgo: 41, note: "Posted that his team is hiring senior PMs", source: "LinkedIn" },
      { id: "b2", type: "In person", daysAgo: 180, note: "Michigan alumni mixer in NYC", source: "You" },
    ],
    cluster: "michigan",
    star: { x: 262, y: 414 },
  },
  {
    id: "grace",
    name: "Grace Liu",
    hue: 60,
    title: "Head of Operations",
    company: "Northwind Logistics",
    city: "Los Angeles",
    closeness: 34,
    lastTouchDays: 5,
    followUpDays: null,
    howMet: "SaaStr Annual, after the ops panel",
    standing: "Scaling Northwind's ops team and evaluating payments partners.",
    nextStep: "Follow up on SaaStr and offer the intro to Elena at Stripe.",
    tags: ["prospect", "operations", "event"],
    timeline: [
      { id: "g1", type: "In person", daysAgo: 5, note: "Met after the ops panel at SaaStr — payments partners", source: "You" },
    ],
    cluster: null,
    star: { x: 470, y: 82 },
  },
  {
    id: "robert",
    name: "Robert Hayes",
    hue: 25,
    title: "CTO",
    company: "Atlas Robotics",
    city: "Pittsburgh",
    closeness: 69,
    lastTouchDays: 30,
    followUpDays: 0,
    followUpLabel: "Send the quarterly update",
    howMet: "Your manager at Atlas, 2022–2024",
    standing: "Likes a short update every quarter; offered to be a reference any time.",
    nextStep: "Send the quarterly update email.",
    tags: ["former manager", "reference"],
    timeline: [
      { id: "r1", type: "Email", daysAgo: 30, note: "Replied to your update — “proud of you, keep going”", source: "Gmail" },
      { id: "r2", type: "Email", daysAgo: 118, note: "Your Q2 update", source: "Gmail" },
    ],
    cluster: null,
    star: { x: 352, y: 418 },
  },
  {
    id: "nina",
    name: "Nina Patel",
    hue: 320,
    title: "Photographer",
    company: "Freelance",
    city: "Brooklyn",
    closeness: 80,
    lastTouchDays: 9,
    followUpDays: null,
    howMet: "College friend",
    standing: "Launching a portfolio site; you offered to look at the copy.",
    nextStep: "Read her site draft this weekend.",
    promise: { text: "look over the copy on her portfolio site", when: "in a text last week", source: "You" },
    tags: ["friend", "creative"],
    timeline: [
      { id: "n1", type: "In person", daysAgo: 9, note: "Brunch — her portfolio launch", source: "You" },
    ],
    cluster: null,
    star: { x: 538, y: 330 },
  },
];

export type HairStyle = "short" | "long" | "bun" | "curly" | "buzz" | "bob" | "wavy";

/** How each person's illustrated portrait is drawn (`Avatar` in demo-ui). */
export type Look = {
  skin: string;
  hair: string;
  style: HairStyle;
  shirt: string;
  glasses?: boolean;
  beard?: boolean;
};

export const LOOKS: Record<string, Look> = {
  maya: { skin: "#8d5524", hair: "#1b1b1b", style: "curly", shirt: "#f2c14e" },
  daniel: { skin: "#f1c27d", hair: "#141414", style: "short", shirt: "#3b82f6", glasses: true },
  priya: { skin: "#c68642", hair: "#171010", style: "long", shirt: "#a78bfa" },
  elena: { skin: "#e0ac69", hair: "#5a3825", style: "wavy", shirt: "#f472b6" },
  marcus: { skin: "#6b4226", hair: "#111111", style: "buzz", shirt: "#10b981", beard: true },
  aisha: { skin: "#7a4a2a", hair: "#121212", style: "bun", shirt: "#f97316" },
  tom: { skin: "#f2c9a0", hair: "#b5651d", style: "short", shirt: "#64748b", beard: true },
  sofia: { skin: "#d9a066", hair: "#3b2314", style: "long", shirt: "#22d3ee" },
  jordan: { skin: "#eac086", hair: "#1f1f1f", style: "short", shirt: "#84cc16" },
  hannah: { skin: "#f5d0b0", hair: "#d4a55a", style: "bob", shirt: "#6366f1", glasses: true },
  ben: { skin: "#efc8a0", hair: "#6b4423", style: "wavy", shirt: "#ef4444" },
  grace: { skin: "#f0c8a0", hair: "#1a1a1a", style: "bob", shirt: "#14b8a6" },
  robert: { skin: "#eac3a2", hair: "#a3a8b3", style: "short", shirt: "#1e3a8a", glasses: true, beard: true },
  nina: { skin: "#b97a4f", hair: "#2a1a12", style: "long", shirt: "#e879f9" },
};

/** Each cluster's nebula colour, echoing the real sky's per-company haze. */
export const CLUSTER_COLORS: Record<ClusterId, string> = {
  figma: "#a78bfa",
  stripe: "#60a5fa",
  deloitte: "#34d399",
  michigan: "#fbbf24",
};

export type SuggestionReason = "Dormant" | "LinkedIn quiet" | "Post-event" | "Score bump";

/** What the recommendation engine surfaces on the Dashboard, in rank order. */
export const DEMO_SUGGESTIONS: { personId: string; reason: SuggestionReason; why: string }[] = [
  { personId: "maya", reason: "Dormant", why: "You said check in monthly — last touch 46 days ago" },
  { personId: "grace", reason: "Post-event", why: "Met at SaaStr 5 days ago — no follow-up logged yet" },
  { personId: "tom", reason: "LinkedIn quiet", why: "He messaged about his new role — thread quiet for 12 days" },
  { personId: "jordan", reason: "Score bump", why: "Three calls this month — Jordan moved into your inner orbit" },
];

export const TOUR_PERSON = "maya";

export function personById(id: string | null | undefined): DemoPerson | undefined {
  return id ? DEMO_PEOPLE.find((p) => p.id === id) : undefined;
}

export function firstName(p: DemoPerson) {
  return p.name.split(" ")[0]!;
}

export function initials(p: DemoPerson) {
  return p.name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2);
}

export type Tier = "inner" | "mid" | "outer";

export function tierOf(closeness: number): Tier {
  return closeness >= 75 ? "inner" : closeness >= 50 ? "mid" : "outer";
}

/** 1–5, what the Strength filter compares against. */
export function strengthOf(closeness: number) {
  return Math.max(1, Math.min(5, Math.ceil(closeness / 20)));
}

export function daysLabel(days: number) {
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.round(days / 7)}w ago`;
  return `${Math.round(days / 30)}mo ago`;
}

export function dueLabel(days: number) {
  if (days < 0) return `Overdue ${-days}d`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due in ${days}d`;
}
