import type { DemoPerson } from "@/lib/demo-data/network";

/**
 * The student / new-grad localhost workspace (`ORBIT_DEMO_PERSONA=student`): about thirty
 * people (alumni, recruiters, professors, classmates, internship colleagues), a career fair,
 * and the reminder lists a job search uses. Nothing about fundraising or outreach campaigns.
 * Emails are on example.com, like the founder seed.
 */

const SCHOOL = "UNC Chapel Hill";

const CORE: DemoPerson[] = [
  {
    fullName: "Priya Shah", firstName: "Priya", lastName: "Shah", title: "Software Engineer", company: "Google", school: SCHOOL,
    location: "Mountain View, CA", email: "priya.shah@example.com", closeness: 4, howMet: "UNC alumni mixer", metContext: "Alumni mixer",
    metDaysAgo: 120, tags: ["Alumni"], standing: "Warm; she offered a referral once your resume is ready.",
    touches: [
      { at: 6, type: "call", notes: "Coffee chat about Google’s new-grad loop. She’ll refer me once my resume is tight.", actionItems: ["Send Priya my updated resume"] },
      { at: 40, type: "linkedin_message", direction: "in", notes: "Replied to my alumni message and suggested a call." },
    ],
    followUpInDays: -2, reminder: { title: "Send Priya my updated resume", inDays: -2, list: "Referrals" },
  },
  {
    fullName: "Marcus Bell", firstName: "Marcus", lastName: "Bell", title: "University Recruiter", company: "Datadog",
    location: "New York, NY", email: "marcus.bell@example.com", closeness: 3, howMet: "Fall career fair", metContext: "Career fair",
    metDaysAgo: 21, tags: ["Recruiter"], standing: "Fresh; email him after you apply.",
    touches: [{ at: 21, type: "event", notes: "Datadog booth. New-grad applications open next week; email him after applying." }],
    followUpInDays: 0, reminder: { title: "Email Marcus after applying to Datadog", inDays: 0, list: "Recruiters" },
  },
  {
    fullName: "Grace Holloway", firstName: "Grace", lastName: "Holloway", title: "Associate Professor of Computer Science", school: SCHOOL,
    location: "Chapel Hill, NC", email: "grace.holloway@example.com", closeness: 4, howMet: "Took her Algorithms course",
    metDaysAgo: 400, tags: ["Professor"], standing: "Supportive; she’ll write a letter once she has your statement.",
    touches: [{ at: 14, type: "in_person", notes: "Office hours. Happy to write a recommendation letter; wants a draft statement by November." }],
    reminder: { title: "Send Professor Holloway my statement draft", inDays: 9 },
  },
  {
    fullName: "Elena Vasquez", firstName: "Elena", lastName: "Vasquez", title: "Engineering Manager", company: "Microsoft",
    location: "Redmond, WA", email: "elena.vasquez@example.com", closeness: 5, howMet: "My summer internship manager",
    metContext: "Summer internship", metDaysAgo: 160, tags: ["Internship"], standing: "Close; return offers are decided in October.",
    touches: [
      { at: 30, type: "call", notes: "Check-in after the internship. Return offer decision comes in October; she’ll flag me to the new-grad team." },
      { at: 90, type: "meeting", notes: "Final internship review. Strong on ownership; keep working on design docs." },
    ],
    followUpInDays: 12,
  },
  {
    fullName: "Jordan Kim", firstName: "Jordan", lastName: "Kim", title: "Computer Science student", school: SCHOOL,
    location: "Chapel Hill, NC", email: "jordan.kim@example.com", closeness: 5, howMet: "Lab partner in Systems", metDaysAgo: 500,
    tags: ["Classmate"], standing: "Close; weekly mock interview swaps.",
    touches: [{ at: 3, type: "message", notes: "Mock interview swap planned for Thursday." }],
  },
  {
    fullName: "Sam Okafor", firstName: "Sam", lastName: "Okafor", title: "Founder", company: "Loop Robotics",
    location: "Durham, NC", email: "sam.okafor@example.com", closeness: 2, howMet: "Career fair startup row", metContext: "Career fair",
    metDaysAgo: 21, tags: ["Founder"], standing: "Interested; send your GitHub.",
    touches: [{ at: 21, type: "event", notes: "Six-person robotics startup hiring a first new-grad engineer. Asked for my GitHub." }],
    reminder: { title: "Send Sam my GitHub and the drone project", inDays: 3, list: "Recruiters" },
  },
  {
    fullName: "Aaliyah Brooks", firstName: "Aaliyah", lastName: "Brooks", title: "Product Designer", company: "Figma", school: SCHOOL,
    location: "San Francisco, CA", email: "aaliyah.brooks@example.com", closeness: 3, howMet: "Alumni panel on design careers",
    metDaysAgo: 75, tags: ["Alumni"], standing: "Friendly; offered to look at your portfolio.",
    touches: [{ at: 45, type: "email", notes: "Shared her portfolio tips and offered to look at mine." }],
  },
  {
    fullName: "Ben Carter", firstName: "Ben", lastName: "Carter", title: "Software Engineer II", company: "Microsoft",
    location: "Redmond, WA", email: "ben.carter@example.com", closeness: 4, howMet: "Intern cohort at Microsoft", metDaysAgo: 160,
    tags: ["Internship"], standing: "Close; his team has a new-grad opening.",
    touches: [{ at: 10, type: "message", notes: "His team has a new-grad opening and he can refer me." }],
    reminder: { title: "Ask Ben for the referral link", inDays: 1, list: "Referrals" },
  },
  {
    fullName: "Nora Lindqvist", firstName: "Nora", lastName: "Lindqvist", title: "Technical Recruiter", company: "Spotify",
    location: "New York, NY", email: "nora.lindqvist@example.com", closeness: 2, howMet: "Reached out on LinkedIn", metDaysAgo: 12,
    tags: ["Recruiter"], standing: "Inbound; asked if you’re open to a backend role.",
    touches: [{ at: 12, type: "linkedin_message", direction: "in", notes: "Asked whether I’m open to a backend new-grad role in New York." }],
    followUpInDays: 4,
  },
  {
    fullName: "David Mensah", firstName: "David", lastName: "Mensah", title: "PhD candidate", school: SCHOOL,
    location: "Chapel Hill, NC", email: "david.mensah@example.com", closeness: 3, howMet: "TA for my Systems course", metDaysAgo: 300,
    tags: ["Professor"], standing: "A mentor; suggested a summer research program.",
    touches: [{ at: 25, type: "in_person", notes: "Talked about research vs industry. Suggested the summer REU program." }],
  },
  {
    fullName: "Hannah Wright", firstName: "Hannah", lastName: "Wright", title: "Career Coach", company: "UNC Career Services",
    location: "Chapel Hill, NC", email: "hannah.wright@example.com", closeness: 3, howMet: "Resume review appointment", metDaysAgo: 50,
    standing: "Helpful; your resume is down to one page.",
    touches: [{ at: 8, type: "meeting", notes: "Resume review. Cut to one page; lead with the internship impact numbers." }],
  },
  {
    fullName: "Leo Martins", firstName: "Leo", lastName: "Martins", title: "Software Engineer", company: "Stripe", school: SCHOOL,
    location: "Seattle, WA", email: "leo.martins@example.com", closeness: 2, howMet: "Alumni Slack", metDaysAgo: 35,
    tags: ["Alumni"], standing: "Cold; no reply to your first message yet.",
    touches: [{ at: 35, type: "linkedin_message", direction: "out", notes: "Asked about Stripe’s new-grad team matching. No reply yet." }],
    followUpInDays: -6,
  },
];

/** [fullName, title, company, school, closeness, howMet, tag] — the lighter long tail. */
const TAIL: Array<[string, string, string | null, string | null, number, string, string]> = [
  ["Chloe Nguyen", "Computer Science student", null, SCHOOL, 4, "Hackathon teammate", "Classmate"],
  ["Ethan Park", "Mathematics student", null, SCHOOL, 3, "Discrete Math study group", "Classmate"],
  ["Maya Robinson", "Data Science student", null, SCHOOL, 3, "ACM club officers", "Classmate"],
  ["Isaac Feld", "Computer Science student", null, "Duke University", 2, "HackNC", "Classmate"],
  ["Olivia Chen", "Software Engineer", "Google", SCHOOL, 2, "Alumni mixer", "Alumni"],
  ["Ravi Patel", "Data Engineer", "Capital One", SCHOOL, 2, "Alumni panel", "Alumni"],
  ["Sophie Martin", "Product Manager", "Microsoft", SCHOOL, 2, "Alumni Slack", "Alumni"],
  ["Tyler Brooks", "Software Engineer", "Epic Games", SCHOOL, 3, "ACM alumni night", "Alumni"],
  ["Grace Liu", "University Recruiter", "Capital One", null, 2, "Fall career fair", "Recruiter"],
  ["Kevin Doyle", "Campus Recruiter", "IBM", null, 1, "Fall career fair", "Recruiter"],
  ["Amara Okeke", "Talent Acquisition Partner", "Red Hat", null, 2, "Info session", "Recruiter"],
  ["Julia Reyes", "Senior Software Engineer", "Microsoft", null, 3, "Internship team", "Internship"],
  ["Marco Rossi", "Software Engineer Intern", "Microsoft", "Georgia Tech", 3, "Intern cohort", "Internship"],
  ["Fatima Zahra", "Program Manager", "Microsoft", null, 2, "Intern events", "Internship"],
  ["Daniel Cho", "Assistant Professor of Statistics", null, SCHOOL, 2, "Probability course", "Professor"],
  ["Lauren Hayes", "Lab Manager", null, SCHOOL, 2, "Robotics lab", "Professor"],
  ["Noah Williams", "Co-founder", "Tarheel Labs", null, 1, "Startup weekend", "Founder"],
  ["Zoe Adams", "Developer Advocate", "GitHub", null, 2, "Campus workshop", "Industry"],
];

function tailPerson([fullName, title, company, school, closeness, howMet, tag]: (typeof TAIL)[number], i: number): DemoPerson {
  const [firstName, ...rest] = fullName.split(" ");
  const lastName = rest.join(" ");
  return {
    fullName,
    firstName,
    lastName,
    title,
    ...(company ? { company } : {}),
    ...(school ? { school } : {}),
    email: `${firstName}.${lastName}`.toLowerCase().replace(/[^a-z.]/g, "") + "@example.com",
    closeness,
    howMet,
    // Touches (15 + 2i) always fall after the meeting (60 + 5i).
    metDaysAgo: 60 + i * 5,
    tags: [tag],
    standing: `Light touch so far; you met through ${howMet.toLowerCase()}.`,
    touches: [{ at: 15 + i * 2, type: i % 2 ? "message" : "event", notes: `${howMet}. Swapped LinkedIn and said to stay in touch.` }],
  };
}

export const STUDENT_PEOPLE: DemoPerson[] = [...CORE, ...TAIL.map(tailPerson)];

export const STUDENT_GOALS: string[] = [
  "Land a new-grad software engineering offer by spring",
  "Get two referrals at target companies",
  "Keep in touch with my internship team",
];

export const STUDENT_LISTS: readonly string[] = ["Recruiters", "Alumni", "Referrals"];

/** A career fair (past) and an alumni night (upcoming), in the shape `seedEvents` takes. */
export function studentEvents(ago: (d: number) => Date, ahead: (d: number) => Date) {
  return [
    {
      values: {
        title: "UNC Fall Career Fair",
        startsAt: ago(21),
        endsAt: new Date(ago(21).getTime() + 4 * 3600_000),
        venue: "Dean E. Smith Center",
        city: "Chapel Hill, NC",
        description: "Engineering and tech employers, plus a startup row.",
      },
      attendees: [
        { name: "Marcus Bell", company: "Datadog", title: "University Recruiter", contact: true },
        { name: "Sam Okafor", company: "Loop Robotics", title: "Founder", contact: true },
        { name: "Grace Liu", company: "Capital One", title: "University Recruiter", contact: true },
        { name: "Kevin Doyle", company: "IBM", title: "Campus Recruiter", contact: true },
      ],
    },
    {
      values: {
        title: "Computer Science alumni night",
        startsAt: ahead(6),
        endsAt: new Date(ahead(6).getTime() + 2 * 3600_000),
        venue: "Sitterson Hall",
        city: "Chapel Hill, NC",
        description: "Alumni from Google, Microsoft and Stripe talk new-grad recruiting.",
      },
      attendees: [
        { name: "Olivia Chen", company: "Google", title: "Software Engineer", contact: true },
        { name: "Leo Martins", company: "Stripe", title: "Software Engineer", contact: true },
      ],
    },
  ];
}
