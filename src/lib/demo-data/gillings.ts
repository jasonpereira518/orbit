/**
 * The Gillings workspace (`persona: "gillings"`): a junior in the BSPH Health Policy &
 * Management program at UNC's Gillings School of Global Public Health, a few months into
 * building a network across North Carolina public health. Seeded for the Gillings pitch
 * competition account, always with the extended surfaces and photos.
 *
 * Three stories run through every page: opportunities reached through people rather than
 * applications, follow-ups that would otherwise be forgotten, and one network spanning
 * academia, state and local health departments, research nonprofits, health systems, pharma
 * and global health.
 *
 * Two kinds of people:
 *  - REAL public figures (`gillings-real.ts`) — faculty, Triangle leaders, global health
 *    leaders. Only public-setting touches (a lecture, office hours, a town hall, a keynote),
 *    no email, no LinkedIn URL.
 *  - MADE-UP peers, alumni and supervisors (this file). Every private conversation, outreach
 *    message, recorded meeting and email is with one of them, and every address is on a
 *    reserved `example.*` domain so nothing can be sent.
 *
 * Constellation shape: clustering keys on the exact `company`, then `school`, then
 * `industry`, so spellings below are deliberate and shared.
 *
 * Pure data. The writers are `seed.ts` and `seed-extended.ts`.
 */
import type { DemoPerson, DemoTouch } from "@/lib/demo-data/network";
import type { DemoCapture, DemoOpportunity } from "@/lib/demo-data/network-extra";
import { portraitUrl } from "@/lib/demo-data/photos";
import type { LongTailSource } from "@/lib/demo-data/long-tail";
import type {
  DemoCampaign,
  DemoChatRec,
  DemoChatThread,
  DemoEvent,
  DemoRecruiter,
  ReminderExtras,
} from "@/lib/demo-data/seed";
import type { DemoCareerMove, DemoGroundedChat, DemoSignal, ExtendedCast } from "@/lib/demo-data/seed-extended";
import { GILLINGS_REAL_PEOPLE } from "@/lib/demo-data/gillings-real";

/* --------------------------------------------------------------------------- shared names */

export const UNC = "UNC Chapel Hill";
export const GILLINGS = "UNC Gillings School of Global Public Health";
const NCCU = "NC Central University";
const RTI = "RTI International";
const NCDHHS = "NC Department of Health and Human Services";
const OCHD = "Orange County Health Department";
const SHEPS = "Cecil G. Sheps Center for Health Services Research";
const UNC_HEALTH = "UNC Health";
const BCBS = "Blue Cross NC";
const DUKE = "Duke University";
const WHO = "World Health Organization";

export const GILLINGS_LISTS = ["Internships & Practicum", "Research & Classes", "Networking"] as const;
const [INTERNSHIPS, RESEARCH, NETWORKING] = GILLINGS_LISTS;

export const GILLINGS_GOALS = [
  "Land a summer 2027 health policy internship in the Triangle",
  "Build relationships with three mentors in North Carolina public health",
  "Present my Sheps Center research at a conference by spring",
];
const [GOAL_INTERNSHIP, GOAL_MENTORS, GOAL_RESEARCH] = GILLINGS_GOALS;

/* ------------------------------------------------------------------------- the made-up core */

type Core = DemoPerson & { gender: "f" | "m" };

const CORE: Core[] = [
  {
    gender: "f",
    fullName: "Priya Raman", firstName: "Priya", lastName: "Raman",
    title: "Research Analyst, Health Policy", company: RTI, school: UNC, industry: "Research",
    location: "Research Triangle Park, NC", email: "priya.raman@example.com",
    linkedinUrl: "https://www.linkedin.com/in/priya-raman-demo",
    closeness: 4, priority: 3,
    howMet: "Gillings alumni panel — she graduated from the BSPH program in 2024",
    metContext: "Gillings alumni panel", metDaysAgo: 64,
    notes: "BSPH HPM '24. Went from a Sheps Center RA job straight to RTI — exactly the path I want. Offered to refer me for RTI's summer 2027 health policy internship once my resume is ready.",
    keyFacts: ["BSPH HPM 2024", "Works on Medicaid evaluation projects at RTI", "Offered an internship referral"],
    sharedInterests: ["Medicaid policy", "rural health"],
    tags: ["Gillings alum", "Mentor"],
    touches: [
      { at: 64, type: "event", notes: "Alumni panel at Gillings. Priya Raman talked about going from a Sheps RA job to RTI's health policy program. Stayed after to ask how she got the interview.", topics: ["careers", "RTI"] },
      { at: 58, type: "linkedin_message", direction: "out", notes: "Thanked her for the panel and asked for 20 minutes to hear more about RTI." },
      { at: 57, type: "linkedin_message", direction: "in", notes: "Said yes and sent her calendar link." },
      { at: 50, type: "call", notes: "Coffee chat on Zoom. RTI hires most summer interns through referrals; she'll refer me once my resume shows the Sheps work.", topics: ["internships", "RTI"], actionItems: ["Send Priya my updated resume"] },
      { at: 12, type: "email", notes: "She introduced me to Daniel Okafor on the health economics team.", topics: ["introduction"] },
    ],
    followUpInDays: -1,
    reminder: { title: "Send Priya my resume for the RTI internship referral", description: "Applications open Nov 1 — she wants it before then so she can flag it.", inDays: -1, list: INTERNSHIPS },
    standing: "Warm and active. She's waiting on your resume to refer you for RTI's summer internship.",
    history: [[RTI, "Research Analyst, Health Policy", 2024, null], [SHEPS, "Undergraduate Research Assistant", 2022, 2024]],
    education: [[UNC, "BSPH, Health Policy and Management", 2020, 2024]],
  },
  {
    gender: "m",
    fullName: "Daniel Okafor", firstName: "Daniel", lastName: "Okafor",
    title: "Health Economist", company: RTI, industry: "Research",
    location: "Durham, NC", email: "daniel.okafor@example.com",
    closeness: 2, priority: 2,
    howMet: "Priya Raman introduced us over email",
    metDaysAgo: 12,
    notes: "Runs cost-effectiveness models for state Medicaid programs. Happy to talk about how economists and policy people work together at RTI.",
    keyFacts: ["Cost-effectiveness modeling", "PhD in health economics"],
    tags: ["RTI"],
    touches: [
      { at: 12, type: "intro", notes: "Priya Raman introduced us. Daniel offered a 30-minute call about the health economics team." },
      { at: 9, type: "email", notes: "Booked a call for next week. He asked what classes I've taken in econ and stats.", actionItems: ["Send Daniel two questions before our call"] },
    ],
    followUpInDays: 4,
    reminder: { title: "Send Daniel two questions before our call", inDays: 3, list: NETWORKING },
    standing: "New. A call is booked; send your questions first.",
    history: [[RTI, "Health Economist", 2021, null]],
    education: [["Vanderbilt University", "PhD, Health Economics", 2015, 2021]],
  },
  {
    gender: "f",
    fullName: "Dr. Elena Ruiz", firstName: "Elena", lastName: "Ruiz",
    title: "Research Scientist", company: SHEPS, industry: "Research",
    location: "Chapel Hill, NC", email: "elena.ruiz@example.edu",
    closeness: 5, priority: 3,
    howMet: "My research supervisor — I'm an undergraduate RA on her rural hospital project",
    metContext: "Sheps Center RA job", metDaysAgo: 220,
    notes: "Leads the rural hospital closures project. Thinks our findings could be a poster at the spring conference and offered to co-author the abstract.",
    keyFacts: ["Rural hospital closures research", "Offered to co-author a poster abstract"],
    sharedInterests: ["rural health", "health services research"],
    tags: ["Research", "Mentor"],
    touches: [
      { at: 220, type: "meeting", notes: "RA onboarding. Data use agreement, the rural closures dataset, and how the project team works." },
      { at: 90, type: "meeting", notes: "Monthly check-in. Moved me onto the obstetric unit closures analysis." },
      { at: 30, type: "meeting", notes: "She thinks the OB closures findings could be a poster at the spring conference and offered to co-author the abstract with me.", topics: ["poster", "research"], actionItems: ["Draft the poster abstract for Dr. Ruiz"] },
    ],
    followUpInDays: 2,
    reminder: { title: "Send Dr. Ruiz the cleaned OB unit closures dataset", description: "She needs it before lab meeting to check the county codes.", inDays: 0, list: RESEARCH },
    standing: "Close. She's co-authoring your poster abstract; the cleaned dataset is due today.",
    history: [[SHEPS, "Research Scientist", 2017, null], ["NC Rural Health Research Program", "Research Associate", 2013, 2017]],
    education: [["University of Michigan", "PhD, Health Services Organization and Policy", 2008, 2013]],
  },
  {
    gender: "m",
    fullName: "Marcus Webb", firstName: "Marcus", lastName: "Webb",
    title: "Graduate Research Assistant", company: SHEPS, school: UNC, industry: "Research",
    location: "Chapel Hill, NC", email: "marcus.webb@example.edu",
    closeness: 3,
    howMet: "Works on the same Sheps Center project",
    metDaysAgo: 200,
    notes: "MSPH student in HPM. Taught me the Stata workflow and knows everyone at NC Medicaid from his practicum.",
    keyFacts: ["MSPH student", "Practicum at NC Medicaid"],
    tags: ["Research"],
    touches: [
      { at: 200, type: "in_person", notes: "He walked me through the project's Stata code and the data dictionary." },
      { at: 40, type: "message", notes: "Offered to introduce me to his practicum supervisor at NC Medicaid if I want to explore policy work there." },
    ],
    standing: "Friendly. He offered an NC Medicaid introduction — take him up on it.",
    history: [[SHEPS, "Graduate Research Assistant", 2025, null], [NCDHHS, "Practicum Student, NC Medicaid", 2025, 2025]],
    education: [[UNC, "MSPH, Health Policy and Management", 2025, 2027]],
  },
  {
    gender: "f",
    fullName: "Angela Brooks", firstName: "Angela", lastName: "Brooks",
    title: "Health Educator & Practicum Coordinator", company: OCHD, industry: "Government Health",
    location: "Hillsborough, NC", email: "angela.brooks@example.org",
    closeness: 3, priority: 2,
    howMet: "Practicum info session at Gillings",
    metDaysAgo: 34,
    notes: "Coordinates student practicums at the county health department. Interested in a student for their community health assessment next summer.",
    keyFacts: ["Coordinates student practicums", "Community health assessment in 2027"],
    tags: ["Practicum", "Mentor"],
    touches: [
      { at: 34, type: "event", notes: "Practicum info session. Orange County is doing its community health assessment next summer and needs a student analyst." },
      { at: 6, type: "email", notes: "Sent the practicum interest form and asked for a writing sample.", actionItems: ["Send Angela the practicum form and a writing sample"] },
    ],
    followUpInDays: 1,
    reminder: { title: "Send Angela the practicum form and a writing sample", inDays: 1, list: INTERNSHIPS },
    standing: "Active. She's waiting on your practicum form and writing sample.",
    history: [[OCHD, "Health Educator & Practicum Coordinator", 2019, null]],
    education: [[NCCU, "MPH, Public Health Education", 2015, 2017]],
  },
  {
    gender: "m",
    fullName: "Tom Nguyen", firstName: "Tom", lastName: "Nguyen",
    title: "Epidemiologist", company: OCHD, industry: "Government Health",
    location: "Hillsborough, NC", email: "tom.nguyen@example.org",
    closeness: 2,
    howMet: "Angela Brooks brought him into our practicum planning call",
    metDaysAgo: 12,
    notes: "Runs the county's disease surveillance and would supervise the data side of the practicum.",
    tags: ["Practicum"],
    touches: [{ at: 12, type: "meeting", notes: "Practicum planning call with Angela Brooks. He'd want R or Stata skills and someone comfortable with BRFSS data." }],
    standing: "New. He'd supervise the data side of the practicum.",
    history: [[OCHD, "Epidemiologist", 2020, null]],
    education: [["NC State University", "MS, Biostatistics", 2017, 2019]],
  },
  {
    gender: "f",
    fullName: "Keisha Johnson", firstName: "Keisha", lastName: "Johnson",
    title: "Senior Policy Analyst, NC Medicaid", company: NCDHHS, school: UNC, industry: "Government Health",
    location: "Raleigh, NC", email: "keisha.johnson@example.org",
    linkedinUrl: "https://www.linkedin.com/in/keisha-johnson-demo",
    closeness: 3, priority: 3,
    howMet: "NC Public Health Association conference — she presented on Medicaid expansion",
    metContext: "NCPHA conference", metDaysAgo: 26,
    notes: "Gillings MPH '22. Works on Medicaid expansion enrollment. Said NC Medicaid takes two undergraduate policy interns each summer and the posting goes up in January.",
    keyFacts: ["Gillings MPH 2022", "Medicaid expansion enrollment work", "NC Medicaid takes two summer policy interns"],
    sharedInterests: ["Medicaid policy"],
    tags: ["Gillings alum", "Policy"],
    touches: [
      { at: 26, type: "event", notes: "Her NCPHA session on Medicaid expansion enrollment. Asked a question about rural enrollment gaps and she found me afterwards.", topics: ["Medicaid", "NCPHA"] },
      { at: 24, type: "linkedin_message", direction: "out", notes: "Followed up on the rural enrollment question and asked about summer internships at NC Medicaid." },
      { at: 22, type: "linkedin_message", direction: "in", notes: "NC Medicaid takes two undergraduate policy interns each summer; the posting goes up in January. Happy to do a call." },
      { at: 4, type: "linkedin_message", direction: "in", notes: "Shared that she was just promoted to Senior Policy Analyst — and that she's on the intern hiring panel this year." },
    ],
    standing: "Warm. She's on NC Medicaid's intern hiring panel — congratulate her and book the call.",
    history: [[NCDHHS, "Senior Policy Analyst, NC Medicaid", 2026, null], [NCDHHS, "Policy Analyst, NC Medicaid", 2022, 2026]],
    education: [[UNC, "MPH, Health Policy", 2020, 2022]],
  },
  {
    gender: "m",
    fullName: "Rahul Mehta", firstName: "Rahul", lastName: "Mehta",
    title: "Data Analyst, Office of Rural Health", company: NCDHHS, industry: "Government Health",
    location: "Raleigh, NC", email: "rahul.mehta@example.org",
    closeness: 2,
    howMet: "NCPHA conference poster session",
    metDaysAgo: 26,
    notes: "Maps rural hospital access for the Office of Rural Health. Our Sheps project uses the same county data.",
    tags: ["Rural health"],
    touches: [{ at: 26, type: "event", notes: "Poster session. He maps hospital access for the Office of Rural Health — same county data as our Sheps project." }],
    standing: "Light. A natural collaborator on the rural closures work.",
    history: [[NCDHHS, "Data Analyst, Office of Rural Health", 2023, null]],
    education: [["East Carolina University", "MPH, Biostatistics", 2021, 2023]],
  },
  {
    gender: "f",
    fullName: "Sofia Alvarez", firstName: "Sofia", lastName: "Alvarez",
    title: "Quality Improvement Analyst", company: UNC_HEALTH, school: UNC, industry: "Health Systems",
    location: "Chapel Hill, NC", email: "sofia.alvarez@example.org",
    closeness: 3, priority: 2,
    howMet: "Gillings alumni mentoring program — she's my assigned mentor",
    metDaysAgo: 75,
    notes: "BSPH HPM '23. Works on readmission reduction at UNC Medical Center. Meets with me once a month.",
    keyFacts: ["BSPH HPM 2023", "Readmission reduction projects"],
    tags: ["Gillings alum", "Mentor"],
    touches: [
      { at: 75, type: "meeting", notes: "First mentoring meeting. Talked about health systems versus government public health careers." },
      { at: 45, type: "call", notes: "Walked me through how QI projects use PDSA cycles. Said to look at UNC Health's summer analytics internship." },
      { at: 15, type: "meeting", notes: "Monthly mentor check-in. Reviewed my resume and suggested leading with the Sheps work.", actionItems: ["Book next month's mentor meeting with Sofia"] },
    ],
    followUpInDays: 13,
    standing: "Steady monthly mentor. Next meeting due in about two weeks.",
    history: [[UNC_HEALTH, "Quality Improvement Analyst", 2023, null]],
    education: [[UNC, "BSPH, Health Policy and Management", 2019, 2023]],
  },
  {
    gender: "f",
    fullName: "Dr. Grace Liu", firstName: "Grace", lastName: "Liu",
    title: "Pediatrician", company: "Duke Health", industry: "Health Systems",
    location: "Durham, NC", email: "grace.liu@example.org",
    closeness: 4,
    howMet: "Family friend — she's known me since high school",
    metDaysAgo: 2200,
    notes: "Encouraged me toward public health after my hospital volunteering. Good person to ask about the clinical side of policy.",
    tags: ["Family friend", "Mentor"],
    touches: [
      { at: 300, type: "in_person", notes: "Dinner over the summer. She talked about vaccine hesitancy in her clinic." },
      { at: 95, type: "message", notes: "Sent her my first Sheps Center project summary. She asked to see the final poster." },
    ],
    standing: "Close but quiet — it's been three months. Send her the poster abstract when it's done.",
    history: [["Duke Health", "Pediatrician", 2012, null]],
    education: [["Duke University", "MD", 2004, 2008]],
  },
  {
    gender: "m",
    fullName: "Jordan Ellis", firstName: "Jordan", lastName: "Ellis",
    title: "Senior Consultant, Health & Human Services", company: "Deloitte", school: UNC, industry: "Consulting",
    location: "Raleigh, NC", email: "jordan.ellis@example.com",
    closeness: 2, priority: 1,
    howMet: "Gillings Career & Internship Fair",
    metDaysAgo: 18,
    notes: "BSPH '21. Deloitte's Government & Public Services practice hires summer analysts who can write and handle data.",
    tags: ["Career fair", "Gillings alum"],
    touches: [{ at: 18, type: "event", notes: "Career fair. Deloitte GPS takes summer analysts; he said to send my resume by Friday and mention his name in the application.", actionItems: ["Send Jordan my resume"] }],
    followUpInDays: -3,
    reminder: { title: "Send Jordan my resume for Deloitte GPS", inDays: -3, list: INTERNSHIPS },
    standing: "Overdue. He asked for your resume after the career fair.",
    history: [["Deloitte", "Senior Consultant, Health & Human Services", 2023, null], ["Deloitte", "Business Technology Analyst", 2021, 2023]],
    education: [[UNC, "BSPH, Health Policy and Management", 2017, 2021]],
  },
  {
    gender: "f",
    fullName: "Nia Thompson", firstName: "Nia", lastName: "Thompson",
    title: "Manager, Population Health Analytics", company: BCBS, industry: "Health Insurance",
    location: "Durham, NC", email: "nia.thompson@example.com",
    closeness: 2,
    howMet: "Gillings Career & Internship Fair",
    metDaysAgo: 18,
    notes: "Just moved from UNC Health to Blue Cross NC. Her team takes an analytics intern each summer; applications close November 15.",
    tags: ["Career fair"],
    touches: [
      { at: 18, type: "event", notes: "Career fair. Blue Cross NC's population health team takes one analytics intern; apply before November 15." },
      { at: 6, type: "linkedin_message", direction: "in", notes: "Accepted my connection request and mentioned she just started at Blue Cross NC." },
    ],
    reminder: { title: "Congratulate Nia on her new role at Blue Cross NC", inDays: 0, list: NETWORKING },
    standing: "New and warm. Congratulate her, then apply before Nov 15.",
    history: [[BCBS, "Manager, Population Health Analytics", 2026, null], [UNC_HEALTH, "Senior Data Analyst", 2020, 2026]],
    education: [["Duke University", "MS, Biostatistics", 2016, 2018]],
  },
  {
    gender: "m",
    fullName: "Ben Carter", firstName: "Ben", lastName: "Carter",
    title: "Associate Director, Real World Evidence", company: "IQVIA", industry: "Health Data & Analytics",
    location: "Durham, NC", email: "ben.carter@example.com",
    closeness: 2,
    howMet: "Gillings Career & Internship Fair",
    metDaysAgo: 18,
    notes: "Leads real-world evidence studies for pharma clients. IQVIA's summer program favors students with SAS or R.",
    tags: ["Career fair"],
    touches: [{ at: 18, type: "event", notes: "Career fair. IQVIA's summer program likes SAS or R; he offered an informational interview." }],
    standing: "Light. He offered an informational interview — follow up while it's fresh.",
    history: [["IQVIA", "Associate Director, Real World Evidence", 2022, null]],
    education: [[UNC, "MPH, Epidemiology", 2012, 2014]],
  },
  {
    gender: "f",
    fullName: "Hannah Kim", firstName: "Hannah", lastName: "Kim",
    title: "Program Officer, Global Health Research", company: "FHI 360", industry: "Global Health",
    location: "Durham, NC", email: "hannah.kim@example.org",
    closeness: 2,
    howMet: "NCPHA conference — sat at the same lunch table",
    metDaysAgo: 26,
    notes: "Works on HIV prevention research in East Africa. FHI 360 takes spring research interns.",
    tags: ["Global health"],
    touches: [
      { at: 26, type: "event", notes: "Lunch at NCPHA. She works on HIV prevention studies; FHI 360 hires spring research interns." },
      { at: 25, type: "email", notes: "Sent her a thank-you and asked her to keep me in mind for spring." },
      { at: 1, type: "linkedin_message", direction: "in", notes: "Posted the spring research intern listing and tagged me." },
    ],
    standing: "Warm. She tagged you on FHI 360's spring intern listing — reply this week.",
    history: [["FHI 360", "Program Officer, Global Health Research", 2021, null]],
    education: [["Emory University", "MPH, Global Health", 2017, 2019]],
  },
  {
    gender: "f",
    fullName: "Maya Patel", firstName: "Maya", lastName: "Patel",
    title: "BSPH Student, Health Policy & Management", school: UNC, industry: "Public Health",
    location: "Chapel Hill, NC", email: "maya.patel@example.edu",
    closeness: 5, priority: 2,
    howMet: "HPM cohort — we're in the same study group",
    metDaysAgo: 400,
    notes: "My closest friend in the cohort. Co-writing our Minority Health Conference abstract on rural maternal care deserts.",
    keyFacts: ["Co-author on the Minority Health Conference abstract"],
    tags: ["Classmate"],
    touches: [
      { at: 60, type: "in_person", notes: "Decided to write the Minority Health Conference abstract together on maternal care deserts." },
      { at: 3, type: "in_person", notes: "Study group for the HPM policy memo. Split up the abstract sections.", actionItems: ["Send Maya the methods paragraph"] },
    ],
    reminder: { title: "Send Maya the methods paragraph for our abstract", inDays: 2, list: RESEARCH },
    standing: "Close. You owe her the methods paragraph.",
    education: [[UNC, "BSPH, Health Policy and Management", 2024, 2028]],
  },
  {
    gender: "m",
    fullName: "Andre Williams", firstName: "Andre", lastName: "Williams",
    title: "BSPH Student, Biostatistics", school: UNC, industry: "Public Health",
    location: "Chapel Hill, NC", email: "andre.williams@example.edu",
    closeness: 4,
    howMet: "Intro to public health class, first year",
    metDaysAgo: 760,
    notes: "The person I go to with R questions. Interned on IQVIA's data team this past summer.",
    tags: ["Classmate"],
    touches: [{ at: 3, type: "in_person", notes: "Study group. He'll look over my regression code for the Sheps analysis." }],
    standing: "Close friend; helping with your R code.",
    history: [["IQVIA", "Data Science Intern", 2026, 2026]],
    education: [[UNC, "BSPH, Biostatistics", 2024, 2028]],
  },
  {
    gender: "f",
    fullName: "Chloe Bennett", firstName: "Chloe", lastName: "Bennett",
    title: "BSPH Student & Gillings Student Ambassador", school: UNC, industry: "Public Health",
    location: "Chapel Hill, NC", email: "chloe.bennett@example.edu",
    closeness: 3,
    howMet: "Public Health Student Association",
    metDaysAgo: 300,
    notes: "Organizes the Gillings alumni panels — she's how I met Priya Raman.",
    tags: ["Classmate"],
    touches: [
      { at: 64, type: "event", notes: "She ran the alumni panel where I met Priya Raman." },
      { at: 3, type: "in_person", notes: "Study group. She's recruiting volunteers for the Minority Health Conference." },
    ],
    standing: "Friendly; well-connected through the ambassador program.",
    education: [[UNC, "BSPH, Health Policy and Management", 2024, 2028]],
  },
  {
    gender: "f",
    fullName: "Lauren Price", firstName: "Lauren", lastName: "Price",
    title: "Career Coach, Gillings Career Services", company: GILLINGS, industry: "Academia",
    location: "Chapel Hill, NC", email: "lauren.price@example.edu",
    closeness: 3,
    howMet: "Resume review appointment",
    metDaysAgo: 80,
    notes: "Said most public health internships are filled through people you already know — told me to keep a list of everyone I meet and follow up within 48 hours.",
    keyFacts: ["Runs mock interviews", "Follow up within 48 hours"],
    tags: ["Career services"],
    touches: [
      { at: 80, type: "meeting", notes: "Resume review. Most public health internships are filled through people you already know — keep a list and follow up within 48 hours." },
      { at: 20, type: "email", notes: "Shared the Gillings internship database and offered a mock interview." },
    ],
    reminder: { title: "Book a mock interview with Lauren", inDays: 5, list: INTERNSHIPS },
    standing: "Helpful. Book the mock interview before the January postings.",
    history: [[GILLINGS, "Career Coach", 2020, null]],
    education: [[NCCU, "MA, Career Counseling", 2014, 2016]],
  },
  {
    gender: "m",
    fullName: "David Osei", firstName: "David", lastName: "Osei",
    title: "MPH Student, Global Health", school: UNC, industry: "Public Health",
    location: "Chapel Hill, NC", email: "david.osei@example.edu",
    closeness: 4,
    howMet: "Gillings peer mentoring program — my assigned peer mentor",
    metDaysAgo: 380,
    notes: "Spent two years with a health NGO in Ghana before the MPH. Pushes me to look at global health internships too.",
    tags: ["Peer mentor"],
    touches: [
      { at: 120, type: "meeting", notes: "Peer mentoring. He suggested the Triangle Global Health Consortium conference." },
      { at: 48, type: "message", notes: "Sent me the FHI 360 and Duke Global Health Institute internship pages." },
    ],
    standing: "Quiet for a few weeks; ask him about the Global Health Consortium conference.",
    education: [[UNC, "MPH, Global Health", 2025, 2027]],
  },
  {
    gender: "f",
    fullName: "Dr. Rebecca Stone", firstName: "Rebecca", lastName: "Stone",
    title: "Clinical Associate Professor, Health Policy & Management", company: GILLINGS, industry: "Academia",
    location: "Chapel Hill, NC", email: "rebecca.stone@example.edu",
    closeness: 3, priority: 2,
    howMet: "Took her HPM 352 health policy analysis course",
    metDaysAgo: 110,
    notes: "My policy memo got her top mark. Said she'd write a recommendation letter if I send a short summary of what I'm applying for.",
    keyFacts: ["Teaches HPM 352", "Will write a recommendation letter"],
    tags: ["Professor", "Mentor"],
    touches: [
      { at: 110, type: "event", notes: "First day of HPM 352." },
      { at: 21, type: "in_person", notes: "Office hours. She'll write a recommendation letter — send a one-paragraph summary and the posting.", actionItems: ["Send Dr. Stone my recommendation letter summary"] },
    ],
    reminder: { title: "Ask Dr. Stone for a recommendation letter (send the summary)", inDays: 6, list: INTERNSHIPS },
    standing: "Supportive. Send the summary so she can write your letter.",
    history: [[GILLINGS, "Clinical Associate Professor, Health Policy & Management", 2016, null]],
    education: [["Johns Hopkins University", "DrPH, Health Policy", 2008, 2012]],
  },
  {
    gender: "m",
    fullName: "Samuel Grant", firstName: "Samuel", lastName: "Grant",
    title: "Research Associate, Duke-Margolis Institute for Health Policy", company: DUKE, school: UNC, industry: "Health Policy",
    location: "Durham, NC", email: "samuel.grant@example.edu",
    closeness: 2, priority: 2,
    howMet: "Cold LinkedIn message to a Gillings alum at Duke-Margolis",
    metDaysAgo: 40,
    notes: "BSPH '22. Duke-Margolis runs a summer undergraduate internship; he'll flag my application to the program lead.",
    keyFacts: ["BSPH 2022", "Duke-Margolis summer internship"],
    tags: ["Gillings alum", "Policy"],
    touches: [
      { at: 40, type: "linkedin_message", direction: "out", notes: "Messaged him as a Gillings student interested in Duke-Margolis's summer internship." },
      { at: 38, type: "linkedin_message", direction: "in", notes: "Replied same day — happy to talk." },
      { at: 31, type: "call", notes: "He'll flag my Duke-Margolis application to the program lead. Deadline is mid-November.", topics: ["internships", "Duke-Margolis"] },
    ],
    followUpInDays: 10,
    reminder: { title: "Submit the Duke-Margolis summer internship application", description: "Tell Samuel once it's in so he can flag it.", inDays: 16, list: INTERNSHIPS },
    standing: "Warm. He'll flag your Duke-Margolis application once you submit.",
    history: [[DUKE, "Research Associate, Duke-Margolis Institute for Health Policy", 2026, null], ["NC Institute of Medicine", "Research Assistant", 2022, 2026]],
    education: [[UNC, "BSPH, Health Policy and Management", 2018, 2022]],
  },
  {
    gender: "f",
    fullName: "Aisha Bello", firstName: "Aisha", lastName: "Bello",
    title: "Public Health Student", school: NCCU, industry: "Public Health",
    location: "Durham, NC", email: "aisha.bello@example.edu",
    closeness: 2,
    howMet: "UNC Minority Health Conference volunteer team",
    metDaysAgo: 240,
    notes: "Studies public health education at NC Central. We're both volunteering at the next Minority Health Conference.",
    tags: ["Minority Health Conference"],
    touches: [{ at: 240, type: "event", notes: "Volunteered together at the Minority Health Conference registration desk." }],
    standing: "Friendly; reconnect for this year's conference.",
    education: [[NCCU, "BS, Public Health Education", 2023, 2027]],
  },
  {
    gender: "m",
    fullName: "Kevin Brooks", firstName: "Kevin", lastName: "Brooks",
    title: "Public Health Student & Research Fellow", school: NCCU, industry: "Public Health",
    location: "Durham, NC", email: "kevin.brooks@example.edu",
    closeness: 2,
    howMet: "Aisha Bello introduced us at the Minority Health Conference",
    metDaysAgo: 240,
    notes: "Researches community health worker programs at NC Central.",
    tags: ["Minority Health Conference"],
    touches: [{ at: 240, type: "event", notes: "Aisha Bello introduced us at the conference; he studies community health worker programs." }],
    standing: "Light; a good contact for community health work.",
    education: [[NCCU, "BS, Public Health Education", 2022, 2026]],
  },
  {
    gender: "f",
    fullName: "Olivia Turner", firstName: "Olivia", lastName: "Turner",
    title: "Technical Officer, Health Systems Governance", company: WHO, industry: "Global Health",
    location: "Geneva, Switzerland", email: "olivia.turner@example.org",
    closeness: 2,
    howMet: "Gillings global health alumni webinar",
    metDaysAgo: 55,
    notes: "Gillings MPH '18, now at WHO in Geneva. Explained how the WHO internship program works for undergraduates.",
    tags: ["Gillings alum", "Global health"],
    touches: [
      { at: 55, type: "event", notes: "Alumni webinar on global health careers. She explained the WHO internship program." },
      { at: 52, type: "email", notes: "Sent her a thank-you; she offered to look at my application next cycle." },
    ],
    standing: "Light but generous; she offered to review a WHO application.",
    history: [[WHO, "Technical Officer, Health Systems Governance", 2021, null]],
    education: [[UNC, "MPH, Health Policy", 2016, 2018]],
  },
  {
    gender: "m",
    fullName: "Ethan Park", firstName: "Ethan", lastName: "Park",
    title: "Co-founder & CEO", company: "CareBridge Analytics", industry: "Health Tech",
    location: "Durham, NC", email: "ethan.park@example.com",
    closeness: 2,
    howMet: "Health innovation meetup at the American Underground",
    metDaysAgo: 70,
    notes: "Building a care-coordination tool for rural clinics. Looking for a part-time student analyst.",
    tags: ["Health tech"],
    touches: [{ at: 70, type: "event", notes: "Health innovation meetup. CareBridge needs a part-time analyst who understands rural clinics." }],
    standing: "Quiet since the meetup — a possible part-time role.",
    history: [["CareBridge Analytics", "Co-founder & CEO", 2024, null]],
    education: [["NC State University", "BS, Computer Science", 2016, 2020]],
  },
  {
    gender: "f",
    fullName: "Rachel Moore", firstName: "Rachel", lastName: "Moore",
    title: "Associate Scientist, Health Outcomes", company: "Biogen", industry: "Pharma & Biotech",
    location: "Research Triangle Park, NC", email: "rachel.moore@example.com",
    closeness: 2,
    howMet: "RTP pharma careers panel",
    metDaysAgo: 85,
    notes: "Works on health outcomes research for neurology drugs. Health outcomes is where pharma hires public health grads.",
    tags: ["Pharma"],
    touches: [{ at: 85, type: "event", notes: "RTP careers panel. Health outcomes and HEOR teams hire public health grads." }],
    standing: "Dormant; worth a check-in before summer applications.",
    history: [["Biogen", "Associate Scientist, Health Outcomes", 2022, null]],
    education: [[UNC, "MSPH, Health Policy and Management", 2019, 2021]],
  },
];

/* ------------------------------------------------------------------------- the lighter tail */

type TailRow = [
  fullName: string,
  title: string,
  company: string | null,
  school: string | null,
  industry: string,
  gender: "f" | "m",
  howMet: string,
  tag: string,
  source: LongTailSource,
  /** Days ago they were met; the one touch happens then. */
  metDaysAgo: number,
];

const TAIL: TailRow[] = [
  ["Isabel Ortiz", "Research Assistant, Health Behavior", null, UNC, "Public Health", "f", "HPM 340 group project", "Classmate", "google_contacts", 50],
  ["Ryan Mitchell", "BSPH Student, Environmental Health Sciences", null, UNC, "Public Health", "m", "Public Health Student Association", "Classmate", "linkedin", 210],
  ["Mei Lin", "BSPH Student, Nutrition", null, UNC, "Public Health", "f", "First-year dorm", "Classmate", "google_contacts", 700],
  ["Jasmine Carter", "BSPH Student, Health Policy & Management", null, UNC, "Public Health", "f", "HPM cohort", "Classmate", "linkedin", 400],
  ["Noah Feldman", "BSPH Student, Biostatistics", null, UNC, "Public Health", "m", "BIOS 600 study group", "Classmate", "google_contacts", 150],
  ["Zoe Harper", "MPH Student, Maternal & Child Health", null, UNC, "Public Health", "f", "Minority Health Conference committee", "Classmate", "linkedin", 240],
  ["Caleb Thompson", "BSPH Student, Health Policy & Management", null, UNC, "Public Health", "m", "HPM cohort", "Classmate", "google_contacts", 400],
  ["Ananya Iyer", "MSPH Student, Epidemiology", null, UNC, "Public Health", "f", "Gillings research symposium", "Classmate", "ai_capture", 95],
  // The duplicate pair for /contacts/duplicates: no shared identity, different company and
  // title, so no auto-merge rule fires; `GILLINGS_DUPLICATES` asks the question instead.
  ["Alex Morgan", "Epidemiology Intern, Division of Public Health", NCDHHS, null, "Government Health", "m", "NCPHA conference", "Policy", "linkedin", 26],
  ["Alexander Morgan", "MPH Student, Epidemiology", null, UNC, "Public Health", "m", "Gillings research symposium", "Classmate", "google_contacts", 95],
  ["Tasha Greene", "University Recruiter", RTI, null, "Research", "f", "Gillings Career & Internship Fair", "Recruiter", "ai_capture", 18],
  ["Kwame Asante", "Research Public Health Analyst", RTI, UNC, "Research", "m", "Alumni panel", "Gillings alum", "linkedin", 64],
  ["Erica Simmons", "Early Careers Recruiter", UNC_HEALTH, null, "Health Systems", "f", "Gillings Career & Internship Fair", "Recruiter", "ai_capture", 18],
  ["Paige Donovan", "Nurse Manager, Population Health", UNC_HEALTH, null, "Health Systems", "f", "Hospital volunteering", "Volunteer", "google_contacts", 500],
  ["Marco Rossi", "Community Health Worker Supervisor", OCHD, null, "Government Health", "m", "Practicum info session", "Practicum", "ai_capture", 34],
  ["Lucia Delgado", "Actuarial Analyst", BCBS, UNC, "Health Insurance", "f", "Alumni networking night", "Gillings alum", "linkedin", 130],
  ["Omar Haddad", "Biostatistician", "IQVIA", null, "Health Data & Analytics", "m", "Andre's IQVIA internship showcase", "Pharma", "linkedin", 90],
  ["Leah Novak", "Research Associate, Maternal Health", "FHI 360", null, "Global Health", "f", "Triangle Global Health Consortium mixer", "Global health", "linkedin", 160],
  ["Mark Delaney", "Campus Recruiter, Government & Public Services", "Deloitte", null, "Consulting", "m", "Gillings Career & Internship Fair", "Recruiter", "ai_capture", 18],
  ["Julia Sorensen", "Research Coordinator", SHEPS, null, "Research", "f", "Sheps Center RA onboarding", "Research", "google_contacts", 220],
  ["Imani Abara", "Program Coordinator, Duke Global Health Institute", DUKE, null, "Global Health", "f", "Triangle Global Health Consortium mixer", "Global health", "linkedin", 160],
  ["Wei Zhang", "Senior Manager, Health Economics & Outcomes Research", "Novo Nordisk", null, "Pharma & Biotech", "m", "RTP pharma careers panel", "Pharma", "linkedin", 85],
  ["Elise Fischer", "Medical Science Liaison", "GSK", null, "Pharma & Biotech", "f", "RTP pharma careers panel", "Pharma", "linkedin", 85],
  ["Tariq Rahimi", "Quality Assurance Specialist", "Fujifilm Diosynth Biotechnologies", null, "Pharma & Biotech", "m", "Health innovation meetup", "Pharma", "ai_capture", 70],
  ["Naomi Achebe", "Country Program Manager", "PATH", null, "Global Health", "f", "Global health alumni webinar", "Global health", "linkedin", 55],
  ["Henrik Lindqvist", "Health Systems Advisor", "Partners In Health", null, "Global Health", "m", "Triangle Global Health Consortium mixer", "Global health", "linkedin", 160],
  ["Adaeze Okonkwo", "Policy Analyst", "NC Institute of Medicine", null, "Health Policy", "f", "NCPHA conference", "Policy", "linkedin", 26],
  ["Sean Byrne", "Senior Policy Analyst", "KFF", null, "Health Policy", "m", "Health policy webinar Q&A", "Policy", "ai_capture", 44],
  ["Riya Kaur", "Product Manager", "Nudge Health", null, "Health Tech", "f", "Health innovation meetup", "Health tech", "linkedin", 70],
  ["Owen Hughes", "Data Engineer", "CareBridge Analytics", null, "Health Tech", "m", "Health innovation meetup", "Health tech", "google_contacts", 70],
  ["Camila Castillo", "Clinical Research Coordinator", "Atrium Health", null, "Health Systems", "f", "Hospital volunteering", "Volunteer", "google_contacts", 520],
  ["Isaac Mercer", "Environmental Health Specialist", "Wake County Public Health", null, "Government Health", "m", "NCPHA conference", "Policy", "ai_capture", 26],
  ["Freya Quinn", "Global Health Fellow", WHO, null, "Global Health", "f", "Global health alumni webinar", "Global health", "linkedin", 55],
  ["Diego Ferreira", "Research Fellow", null, NCCU, "Public Health", "m", "Minority Health Conference", "Minority Health Conference", "ai_capture", 240],
];

function tailPerson([fullName, title, company, school, industry, , howMet, tag, , metDaysAgo]: TailRow, i: number): DemoPerson {
  const [firstName, ...rest] = fullName.split(" ");
  const lastName = rest.join(" ");
  // Indexed, so the duplicate pair never shares an address (an identity match would merge them).
  const email = `${firstName}.${lastName}.${i}`.toLowerCase().replace(/[^a-z0-9.]/g, "") + `@example.${school ? "edu" : "org"}`;
  const touch: DemoTouch = { at: metDaysAgo, type: "event", notes: `${howMet}. Exchanged contact info.` };
  return {
    fullName, firstName, lastName, title,
    ...(company ? { company } : {}),
    ...(school ? { school } : {}),
    industry,
    location: company === WHO ? "Geneva, Switzerland" : "Research Triangle, NC",
    email,
    closeness: 1 + (i % 2),
    howMet,
    metDaysAgo,
    tags: [tag],
    touches: [touch],
    standing: "Light. One conversation so far.",
  };
}

/* ------------------------------------------------------------------------------- the cast */

const CORE_PEOPLE: DemoPerson[] = CORE.map(({ gender: _gender, ...p }) => p);
const TAIL_PEOPLE: DemoPerson[] = TAIL.map(tailPerson);

/** Everyone: real people, the made-up core, then the tail. */
export const GILLINGS_PEOPLE: DemoPerson[] = [
  ...GILLINGS_REAL_PEOPLE.map((r) => r.person),
  ...CORE_PEOPLE,
  ...TAIL_PEOPLE,
];

export function buildGillingsCast(): ExtendedCast {
  const photos = new Map<string, string | null>();
  const contactSource = new Map<string, LongTailSource>();
  for (const r of GILLINGS_REAL_PEOPLE) {
    photos.set(r.person.fullName, r.photoUrl);
    contactSource.set(r.person.fullName, "ai_capture");
  }
  const next = { f: 5, m: 5 };
  const take = (g: "f" | "m") => portraitUrl(g, (next[g] += 7));
  for (const p of CORE) {
    photos.set(p.fullName, take(p.gender));
    const linkedin = (p.touches ?? []).some((t) => t.type === "linkedin_message") || Boolean(p.linkedinUrl);
    contactSource.set(p.fullName, linkedin ? "linkedin" : p.email ? "google_contacts" : "ai_capture");
  }
  for (const row of TAIL) {
    photos.set(row[0], take(row[5]));
    contactSource.set(row[0], row[8]);
  }
  return {
    people: GILLINGS_PEOPLE,
    photos,
    contactSource,
    captures: GILLINGS_CAPTURES,
    opportunities: GILLINGS_OPPORTUNITIES,
    groundedChat: GILLINGS_GROUNDED_CHAT,
    careerMoves: GILLINGS_CAREER_MOVES,
    signals: GILLINGS_SIGNALS,
    goalFit: GILLINGS_GOAL_FIT,
    duplicates: [{ a: "Alex Morgan", b: "Alexander Morgan", reason: "Similar name", confidence: 0.7 }],
  };
}

/* ---------------------------------------------------------------------------- reminders */

export const GILLINGS_REMINDER_EXTRAS: ReminderExtras = {
  rows: ({ listFor, contactId, ahead }) => [
    {
      listId: listFor(RESEARCH),
      title: "Submit the Minority Health Conference abstract",
      description: "Maternal care deserts in rural NC, with Maya. Under 300 words.",
      dueDate: ahead(9),
      actionKind: "task",
    },
    {
      listId: listFor(INTERNSHIPS),
      title: "Update my resume with the Sheps Center RA work",
      description: "Lead with the OB unit closures analysis, like Sofia suggested.",
      dueDate: ahead(-2),
      actionKind: "task",
    },
    { listId: listFor(RESEARCH), title: "HPM 352 policy memo due", dueDate: ahead(2), actionKind: "task" },
    {
      listId: listFor(NETWORKING),
      title: "Register for the Triangle Global Health Consortium conference",
      description: "Student registration closes Friday. David Osei is going too.",
      dueDate: ahead(4),
      actionKind: "task",
    },
    {
      contactId: contactId("Keisha Johnson"),
      listId: listFor(NETWORKING),
      title: "Congratulate Keisha on her promotion and book the NC Medicaid call",
      dueDate: ahead(0),
      actionKind: "email",
    },
    {
      contactId: contactId("Hannah Kim"),
      listId: listFor(INTERNSHIPS),
      title: "Reply to Hannah about FHI 360's spring research internship",
      dueDate: ahead(3),
      actionKind: "email",
    },
    {
      contactId: contactId("Ben Carter"),
      listId: listFor(NETWORKING),
      title: "Ask Ben for the IQVIA informational interview he offered",
      dueDate: ahead(8),
      actionKind: "email",
    },
    {
      contactId: contactId("Kristen Hassmiller Lich"),
      listId: listFor(RESEARCH),
      title: "Read the group model building papers from Dr. Hassmiller Lich's office hours",
      dueDate: ahead(12),
      actionKind: "task",
    },
    {
      contactId: contactId("Dr. Grace Liu"),
      listId: listFor(NETWORKING),
      title: "Send Dr. Liu the poster abstract once it's final",
      dueDate: ahead(21),
      actionKind: "email",
    },
    { listId: listFor(NETWORKING), title: "Write down three takeaways from every coffee chat", actionKind: "task" },
    {
      contactId: contactId("Angela Brooks"),
      listId: listFor(INTERNSHIPS),
      title: "Thank Angela for the practicum info session",
      dueDate: ahead(-33),
      status: "done",
      actionKind: "email",
    },
    {
      contactId: contactId("Priya Raman"),
      listId: listFor(NETWORKING),
      title: "Thank Priya for the coffee chat",
      dueDate: ahead(-49),
      status: "done",
      actionKind: "email",
    },
    { listId: listFor(RESEARCH), title: "Submit the HPM 340 group project", dueDate: ahead(-4), status: "done", actionKind: "task" },
  ],
  suggested: {
    source:
      "Career fair follow-ups: promised Jordan Ellis my resume by Friday, and Nia Thompson wants me to apply to Blue Cross NC's population health analytics internship before November 15.",
    pending: [
      { contact: "Nia Thompson", title: "Apply to Blue Cross NC's analytics internship", inDays: 30, excerpt: "apply to Blue Cross NC's population health analytics internship before November 15" },
      { contact: "Jordan Ellis", title: "Email Jordan my resume", inDays: 2, excerpt: "promised Jordan Ellis my resume by Friday" },
    ],
  },
};

/* ----------------------------------------------------------------------------- outreach */

export function gillingsCampaigns(ago: (d: number) => Date): DemoCampaign[] {
  return [
    {
      values: {
        name: "Summer 2027 internships — Triangle health orgs",
        status: "active",
        audienceQuery: "Gillings alumni and internship coordinators at health policy organizations in the Research Triangle",
        audienceFilters: { titles: ["Policy Analyst", "Internship Coordinator", "Research Associate"], locations: ["Raleigh, NC", "Durham, NC", "Chapel Hill, NC"] },
        messageIntent: "Ask about summer 2027 health policy internships and request a short conversation",
        replyCta: "book_intro",
        tone: "friendly",
        defaultChannel: "email",
        sequenceSteps: [{ delayDays: 0 }, { delayDays: 5, intent: "Short, friendly bump" }],
        lastSearchSource: "demo",
        createdAt: ago(28),
        updatedAt: ago(2),
      },
      prospects: [
        {
          name: "Keisha Johnson",
          title: "Senior Policy Analyst, NC Medicaid",
          company: NCDHHS,
          contact: true,
          status: "interested",
          messages: [
            {
              subject: "Gillings student — NC Medicaid summer internship",
              body: "Hi Keisha — thank you again for your NCPHA session on Medicaid expansion enrollment. I'm a BSPH HPM junior working on rural hospital closures at the Sheps Center, and I'd love to hear how you got started at NC Medicaid. Would 20 minutes in the next few weeks work?",
              status: "sent",
              sentDaysAgo: 23,
              outcome: "positive_reply",
              repliedDaysAgo: 22,
              outcomeNotes: "Two undergraduate policy interns each summer; the posting goes up in January. Happy to talk.",
            },
          ],
        },
        {
          name: "Samuel Grant",
          title: "Research Associate, Duke-Margolis Institute for Health Policy",
          company: DUKE,
          contact: true,
          status: "replied",
          messages: [
            {
              subject: "Fellow Gillings HPM — Duke-Margolis internship",
              body: "Hi Samuel — I'm a BSPH HPM junior at Gillings and saw you made the jump to Duke-Margolis. I'm applying to the summer undergraduate internship and would value 15 minutes of advice.",
              status: "sent",
              sentDaysAgo: 40,
              outcome: "positive_reply",
              repliedDaysAgo: 38,
              outcomeNotes: "Will flag my application to the program lead.",
            },
          ],
        },
        {
          name: "Nia Thompson",
          title: "Manager, Population Health Analytics",
          company: BCBS,
          contact: true,
          status: "contacted",
          messages: [
            {
              subject: "Great to meet you at the Gillings career fair",
              body: "Hi Nia — it was great meeting you at the Gillings career fair. Congratulations on the move to Blue Cross NC! I'm applying to your population health analytics internship and would love to learn what the team is working on.",
              status: "sent",
              sentDaysAgo: 5,
            },
            // Ready to send, never `scheduled`: a scheduled row with a past time is what the
            // outreach sender picks up, and demo data must never send.
            {
              subject: "Re: Great to meet you at the Gillings career fair",
              body: "Hi Nia — just floating this back up before the November 15 deadline. Happy to send a short summary of my Sheps Center analytics work instead of a call.",
              status: "generated",
              stepIndex: 1,
            },
          ],
        },
        {
          name: "Laura Chen",
          title: "Internship Coordinator",
          company: "NC Institute of Medicine",
          email: "laura.chen@example.org",
          location: "Morrisville, NC",
          status: "contacted",
          messages: [
            {
              subject: "Summer internship at the NC Institute of Medicine",
              body: "Hi Laura — I'm a Gillings BSPH junior in Health Policy & Management. Samuel Grant spoke highly of his time at NCIOM. Is the summer 2027 internship cycle open yet?",
              status: "sent",
              sentDaysAgo: 8,
            },
          ],
        },
        {
          name: "Omar Siddiqui",
          title: "Program Manager",
          company: "Duke Global Health Institute",
          location: "Durham, NC",
          status: "selected",
          messages: [
            {
              subject: "Gillings student interested in DGHI's summer program",
              body: "Hi Omar — David Osei, a Gillings MPH student, suggested I reach out about Duke Global Health Institute's summer research program. Would you have 15 minutes?",
              status: "generated",
            },
          ],
        },
        { name: "Grace Owens", title: "HR Partner, Public Health", company: "Wake County Public Health", location: "Raleigh, NC", status: "suggested" },
      ],
    },
    {
      values: {
        name: "Informational interviews — Gillings alumni",
        status: "active",
        audienceQuery: "Gillings BSPH alumni in health systems, insurers and health data companies",
        audienceFilters: { titles: ["Analyst", "Manager", "Associate Director"], industries: ["Hospital & Health Care", "Health Insurance"] },
        messageIntent: "Ask a Gillings alum for a 20-minute informational interview about their career path",
        replyCta: "book_intro",
        tone: "professional",
        defaultChannel: "email",
        sequenceSteps: [{ delayDays: 0 }],
        lastSearchSource: "demo",
        createdAt: ago(80),
        updatedAt: ago(4),
      },
      prospects: [
        {
          name: "Sofia Alvarez",
          title: "Quality Improvement Analyst",
          company: UNC_HEALTH,
          contact: true,
          status: "interested",
          messages: [
            {
              subject: "Gillings mentoring program — hello!",
              body: "Hi Sofia — I'm your mentee through the Gillings alumni program. Would you be open to a first meeting in the next couple of weeks?",
              status: "sent",
              sentDaysAgo: 78,
              outcome: "meeting_booked",
              repliedDaysAgo: 77,
              outcomeNotes: "Booked a monthly mentor meeting.",
            },
          ],
        },
        {
          name: "Ben Carter",
          title: "Associate Director, Real World Evidence",
          company: "IQVIA",
          contact: true,
          status: "contacted",
          messages: [
            {
              subject: "Following up from the Gillings career fair",
              body: "Hi Ben — thanks for the conversation at the career fair. I'd love to take you up on the informational interview about real-world evidence work at IQVIA.",
              status: "sent",
              sentDaysAgo: 15,
            },
          ],
        },
        {
          name: "Hannah Kim",
          title: "Program Officer, Global Health Research",
          company: "FHI 360",
          contact: true,
          status: "replied",
          messages: [
            {
              subject: "Great meeting you at NCPHA",
              body: "Hi Hannah — I enjoyed hearing about FHI 360's HIV prevention research at lunch. Would you keep me in mind for spring research internships?",
              status: "sent",
              sentDaysAgo: 25,
              outcome: "neutral_reply",
              repliedDaysAgo: 24,
              outcomeNotes: "Will share the posting when it's live.",
            },
          ],
        },
        { name: "Ivy Mendes", title: "Senior Analyst", company: "Center for Health Care Strategies", location: "Remote", status: "suggested" },
      ],
    },
  ];
}

/* --------------------------------------------------------------------------- recruiters */

export function gillingsRecruiters(ago: (d: number) => Date): DemoRecruiter[] {
  return [
    {
      fullName: "Tasha Greene",
      firm: RTI,
      specialty: ["Public Health", "Research"],
      email: "tasha.greene@rti.example",
      linkedinUrl: null,
      contact: "Tasha Greene",
      link: {
        status: "active",
        personalRating: 5,
        notes: "Runs RTI's university recruiting. Referrals from current staff go to the top of her pile.",
        aiSummary: "Three emails since the career fair. Tasha confirmed RTI's summer 2027 internship applications open Nov 1 and said staff referrals are reviewed first.",
        companiesMentioned: [RTI],
        rolesDiscussed: ["Summer Intern, Health Policy", "Research Assistant"],
        firstEmailAt: ago(17),
        lastEmailAt: ago(4),
        emailCount: 3,
      },
      message: {
        intent: "upcoming_drops",
        subject: "RTI summer 2027 internships",
        body: "Hi Tasha — thank you for confirming the November 1 opening. Priya Raman on the health policy team plans to refer me; is there anything else I should include with my application?",
        status: "sent",
        sentAt: ago(4),
      },
    },
    {
      fullName: "Mark Delaney",
      firm: "Deloitte",
      specialty: ["Consulting", "Government & Public Services"],
      email: "mark.delaney@deloitte.example",
      linkedinUrl: null,
      contact: "Mark Delaney",
      link: {
        status: "contacted",
        personalRating: 3,
        notes: "Campus recruiter for GPS. Summer analyst applications close in December.",
        aiSummary: "Two emails about Deloitte's Government & Public Services summer analyst program; he shared the December deadline.",
        companiesMentioned: ["Deloitte"],
        rolesDiscussed: ["Summer Analyst, Government & Public Services"],
        firstEmailAt: ago(17),
        lastEmailAt: ago(10),
        emailCount: 2,
      },
      message: {
        intent: "set_up_chat",
        subject: "Quick chat about the GPS summer analyst program?",
        body: "Hi Mark — Jordan Ellis suggested I reach out. Could we find 15 minutes to talk about the health and human services work in GPS?",
        status: "draft",
        sentAt: null,
      },
    },
    {
      fullName: "Erica Simmons",
      firm: UNC_HEALTH,
      specialty: ["Health Systems", "Analytics"],
      email: "erica.simmons@unchealth.example",
      linkedinUrl: null,
      contact: "Erica Simmons",
      link: {
        status: "planned",
        personalRating: 4,
        notes: "Early careers recruiter. Sofia Alvarez says the summer analytics internship posts in February.",
        aiSummary: null,
        companiesMentioned: [UNC_HEALTH],
        rolesDiscussed: ["Summer Analytics Intern"],
        firstEmailAt: ago(17),
        lastEmailAt: ago(17),
        emailCount: 1,
      },
      message: null,
    },
  ];
}

/* ------------------------------------------------------------------------------- events */

export function gillingsEvents(ago: (d: number) => Date, ahead: (d: number) => Date): DemoEvent[] {
  const hours = (d: Date, h: number) => new Date(d.getTime() + h * 3600_000);
  return [
    {
      values: {
        title: "Gillings Career & Internship Fair",
        startsAt: ago(18),
        endsAt: hours(ago(18), 3),
        venue: "Michael Hooker Research Center",
        city: "Chapel Hill, NC",
        description: "Employers from state government, research nonprofits, health systems and consulting.",
        attendeeCount: 400,
        notes: "Went with a list of six employers. Best conversations: Deloitte, Blue Cross NC, IQVIA, RTI.",
      },
      attendees: [
        { name: "Jordan Ellis", company: "Deloitte", title: "Senior Consultant", contact: true },
        { name: "Nia Thompson", company: BCBS, title: "Manager, Population Health Analytics", contact: true },
        { name: "Ben Carter", company: "IQVIA", title: "Associate Director, Real World Evidence", contact: true },
        { name: "Tasha Greene", company: RTI, title: "University Recruiter", contact: true },
        { name: "Erica Simmons", company: UNC_HEALTH, title: "Early Careers Recruiter", contact: true },
        { name: "Mark Delaney", company: "Deloitte", title: "Campus Recruiter", contact: true },
      ],
    },
    {
      values: {
        title: "NC Public Health Association Fall Conference",
        startsAt: ago(26),
        endsAt: hours(ago(26), 8),
        city: "North Carolina",
        description: "Sessions on Medicaid expansion, rural health and the public health workforce.",
        attendeeCount: 900,
        notes: "Asked a question at Keisha's Medicaid session — that one question turned into an internship lead.",
      },
      attendees: [
        { name: "Keisha Johnson", company: NCDHHS, title: "Policy Analyst, NC Medicaid", role: "speaker", contact: true },
        { name: "Devdutta Sangvai", company: NCDHHS, title: "Secretary", role: "speaker", contact: true },
        { name: "Rahul Mehta", company: NCDHHS, title: "Data Analyst, Office of Rural Health", contact: true },
        { name: "Hannah Kim", company: "FHI 360", title: "Program Officer", contact: true },
        { name: "Adaeze Okonkwo", company: "NC Institute of Medicine", title: "Policy Analyst", contact: true },
        { name: "Isaac Mercer", company: "Wake County Public Health", title: "Environmental Health Specialist", contact: true },
      ],
    },
    {
      values: {
        title: "Gillings Alumni Career Panel: Health Policy Paths",
        startsAt: ago(64),
        endsAt: hours(ago(64), 2),
        venue: "Rosenau Hall",
        city: "Chapel Hill, NC",
        attendeeCount: 60,
        notes: "Met Priya Raman here. She's now referring me to RTI.",
      },
      attendees: [
        { name: "Priya Raman", company: RTI, title: "Research Analyst", role: "speaker", contact: true },
        { name: "Kwame Asante", company: RTI, title: "Research Public Health Analyst", role: "speaker", contact: true },
        { name: "Chloe Bennett", title: "Gillings Student Ambassador", role: "host", contact: true },
      ],
    },
    {
      values: {
        title: "Gillings Dean's Town Hall",
        startsAt: ago(40),
        endsAt: hours(ago(40), 1.5),
        venue: "Rosenau Hall",
        city: "Chapel Hill, NC",
        attendeeCount: 250,
        notes: "Asked about undergraduate pathways into pandemic preparedness.",
      },
      attendees: [{ name: "Nancy Messonnier", company: GILLINGS, title: "Dean", role: "host", contact: true }],
    },
    {
      values: {
        title: "Triangle Global Health Consortium Annual Conference",
        startsAt: ahead(11),
        endsAt: hours(ahead(11), 7),
        city: "Durham, NC",
        description: "Researchers, NGOs and companies working on global health across the Triangle.",
        attendeeCount: 500,
        notes: "Going with David Osei. Goal: meet two people from FHI 360 or Duke Global Health.",
      },
      attendees: [
        { name: "David Osei", title: "MPH Student, Global Health", contact: true },
        { name: "Hannah Kim", company: "FHI 360", title: "Program Officer", contact: true },
        { name: "Imani Abara", company: DUKE, title: "Program Coordinator, Duke Global Health Institute", contact: true },
        { name: "Leah Novak", company: "FHI 360", title: "Research Associate", contact: true },
      ],
    },
    {
      values: {
        title: "UNC Minority Health Conference",
        startsAt: ahead(122),
        endsAt: hours(ahead(122), 8),
        venue: "William and Ida Friday Center",
        city: "Chapel Hill, NC",
        description: "The student-run conference on health equity.",
        attendeeCount: 1000,
        notes: "Abstract with Maya under review. Volunteering at registration again with Aisha.",
      },
      attendees: [
        { name: "Maya Patel", title: "BSPH Student", contact: true },
        { name: "Aisha Bello", title: "Public Health Student, NCCU", contact: true },
        { name: "Zoe Harper", title: "Conference Committee", role: "host", contact: true },
      ],
    },
  ];
}

/* --------------------------------------------------------------------------------- chat */

export const GILLINGS_CHAT = (rec: DemoChatRec): DemoChatThread[] => [
  {
    title: "Who should I follow up with this week?",
    daysAgo: 1,
    question: "Who should I follow up with this week?",
    answer:
      "Three follow-ups are slipping. Jordan Ellis asked for your resume after the career fair and it's three days overdue, and Priya Raman is waiting on the same resume before RTI's November 1 opening — send both today. Keisha Johnson was just promoted and is on NC Medicaid's intern hiring panel, so congratulate her and book the call she offered. Nia Thompson started at Blue Cross NC this week; a quick congratulations keeps you top of mind before her November 15 deadline.",
    recommendations: [
      rec("Priya Raman", "Waiting on your resume to refer you to RTI; a day overdue.", "Send your updated resume", "Hi Priya — here's my updated resume, now leading with the Sheps Center OB unit closures work. Thank you so much for offering to refer me!"),
      rec("Jordan Ellis", "Asked for your resume at the career fair; three days overdue.", "Email your resume", null),
      rec("Keisha Johnson", "Just promoted; on the intern hiring panel.", "Congratulate her and book the call", "Hi Keisha — congratulations on the promotion! Would you still have 20 minutes for a call about NC Medicaid's summer internship?"),
      rec("Nia Thompson", "Started at Blue Cross NC this week.", "Send a quick congratulations", null),
    ],
  },
  {
    title: "Prep me for my call with Keisha",
    daysAgo: 4,
    question: "Prep me for my call with Keisha Johnson at NC Medicaid.",
    answer:
      "Keisha is a Gillings MPH '22 who works on Medicaid expansion enrollment, and you met at her NCPHA session after you asked about rural enrollment gaps. Key points to bring: your Sheps Center work on rural OB unit closures (it overlaps with her rural enrollment question), and that NC Medicaid takes two undergraduate policy interns each summer with a posting in January. Good questions: what last summer's interns worked on, which skills set candidates apart, and whether a writing sample helps. Marcus Webb did his practicum at NC Medicaid and offered an introduction — mention him.",
    recommendations: [
      rec("Keisha Johnson", "Your call is coming up; she's on the intern hiring panel.", "Send two questions ahead of the call", null),
      rec("Marcus Webb", "Did his practicum at NC Medicaid.", "Ask him what made his practicum application stand out", null),
    ],
  },
];

export const GILLINGS_GROUNDED_CHAT: DemoGroundedChat = {
  title: "Who can help me land a health policy internship?",
  question: "Who in my network can help me land a health policy internship next summer?",
  understandDetail: "Internships · health policy · summer 2027",
  citations: [
    ["Priya Raman", "refer me"],
    ["Keisha Johnson", "two undergraduate policy interns"],
    ["Samuel Grant", "flag my Duke-Margolis application"],
    ["Dr. Elena Ruiz", "poster"],
  ],
  answer:
    "You have more doors open than it feels like. Priya Raman will refer you to RTI's health policy internship as soon as she has your resume [e1] — RTI fills most summer roles through referrals. Keisha Johnson told you NC Medicaid takes two undergraduate policy interns each summer [e2], and she's now on the hiring panel. Samuel Grant offered to flag your Duke-Margolis application to the program lead [e3]. And Dr. Elena Ruiz is co-authoring your poster abstract [e4], which gives every application a concrete research result to point to. None of these came from a job board — each one came from a conversation you followed up on.",
  recommendations: [
    {
      person: "Priya Raman",
      reason: "Will refer you to RTI once she has your resume.",
      action: "Send the updated resume today",
      draft: "Hi Priya — here's my updated resume, now leading with the Sheps Center work. Thank you again for offering to refer me for the summer internship!",
    },
    { person: "Keisha Johnson", reason: "On NC Medicaid's intern hiring panel this year.", action: "Book the call she offered", draft: null },
    { person: "Samuel Grant", reason: "Will flag your Duke-Margolis application.", action: "Tell him when your application is in", draft: null },
  ],
};

/* ---------------------------------------------------------------- captures and meetings */

export const GILLINGS_CAPTURES: DemoCapture[] = [
  {
    title: "Gillings Career & Internship Fair",
    daysAgo: 18,
    kind: "voice",
    text:
      "Career fair notes. Jordan Ellis at Deloitte: GPS takes summer analysts, send my resume by Friday and mention his name. Nia Thompson at Blue Cross NC: one population health analytics intern, apply before November 15. Ben Carter at IQVIA: summer program likes SAS or R, offered an informational interview. Follow up with all three within 48 hours.",
    participants: ["Jordan Ellis", "Nia Thompson", "Ben Carter"],
    interactionType: "event",
    topics: ["career fair", "internships"],
  },
  {
    title: "NCPHA conference — Medicaid and rural health",
    daysAgo: 26,
    kind: "voice",
    text:
      "NCPHA day one. Keisha Johnson's Medicaid expansion session — asked about rural enrollment gaps and she found me afterwards; NC Medicaid takes two undergrad policy interns. Rahul Mehta maps hospital access for the Office of Rural Health, same county data as our Sheps project. Lunch with Hannah Kim from FHI 360 — spring research interns.",
    participants: ["Keisha Johnson", "Rahul Mehta", "Hannah Kim"],
    interactionType: "event",
    topics: ["NCPHA", "Medicaid", "rural health"],
  },
  {
    title: "Informational interview — RTI health policy team",
    daysAgo: 9,
    kind: "calendar",
    text:
      "Call with Priya Raman and Daniel Okafor about RTI's health policy and health economics teams. Summer interns are mostly referred by staff. Bring a writing sample and lead with the Sheps work.",
    participants: ["Priya Raman", "Daniel Okafor"],
    interactionType: "meeting",
    topics: ["RTI", "internships"],
    meeting: {
      durationMin: 28,
      summary:
        "Priya and Daniel explained how RTI's summer internship works: most interns are referred by staff, projects are real client work, and a short writing sample matters more than GPA. Priya will refer James once his resume leads with the Sheps Center analysis; Daniel suggested learning the basics of cost-effectiveness analysis before applying.",
      keyPoints: [
        "Most RTI summer interns come in through staff referrals",
        "A short writing sample matters more than GPA",
        "Interns work on real Medicaid evaluation projects",
        "Cost-effectiveness basics would set James apart",
      ],
      decisions: ["Priya will refer James once his resume is updated"],
      actionItems: [
        { text: "Send Priya the updated resume", owner: "James" },
        { text: "Send Daniel two questions about health economics", owner: "James" },
        { text: "Flag James's application to the internship lead", owner: "Priya Raman" },
      ],
      openQuestions: [{ text: "Does RTI take undergraduates for the health economics team, or only policy?", askedBy: "James" }],
      transcript: [
        { speaker: "Priya Raman", text: "Honestly, most of our summer interns come in through someone on staff. Applications alone are a long shot." },
        { speaker: "James", text: "That's what I keep hearing. What would make my application stand out once you refer it?" },
        { speaker: "Priya Raman", text: "Lead with the Sheps work. A real analysis of rural OB closures is exactly what our Medicaid team does." },
        { speaker: "Daniel Okafor", text: "And a short writing sample. We care more about clear writing than GPA." },
        { speaker: "James", text: "Would it help to learn some cost-effectiveness analysis before the summer?" },
        { speaker: "Daniel Okafor", text: "Definitely. Even the basics would put you ahead. I can send you a primer." },
        { speaker: "Priya Raman", text: "Send me the resume when it's updated and I'll flag it to the internship lead." },
      ],
    },
  },
  {
    title: "Practicum planning — Orange County Health Department",
    daysAgo: 12,
    kind: "calendar",
    text:
      "Practicum planning with Angela Brooks and Tom Nguyen. The county's community health assessment runs next summer and needs a student analyst comfortable with BRFSS data. Next step: practicum form and a writing sample to Angela.",
    participants: ["Angela Brooks", "Tom Nguyen"],
    interactionType: "meeting",
    topics: ["practicum", "community health assessment"],
    meeting: {
      durationMin: 34,
      summary:
        "Angela and Tom outlined a summer practicum on Orange County's 2027 community health assessment. The student would clean BRFSS and county survey data, help run community listening sessions, and draft sections of the final report. Angela needs the practicum form and a writing sample to move forward.",
      keyPoints: [
        "Community health assessment runs summer 2027",
        "Data work with BRFSS and county surveys",
        "Student co-leads two community listening sessions",
        "Writing sample required",
      ],
      decisions: ["James will apply for the CHA practicum slot"],
      actionItems: [
        { text: "Send the practicum form and a writing sample", owner: "James" },
        { text: "Share last cycle's CHA report as an example", owner: "Angela Brooks" },
      ],
      openQuestions: [{ text: "Can the practicum count toward the BSPH field experience requirement?", askedBy: "James" }],
      transcript: [
        { speaker: "Angela Brooks", text: "Every three years we do a community health assessment, and next summer is our year." },
        { speaker: "Tom Nguyen", text: "The student would mostly help with the data — BRFSS plus our own county survey." },
        { speaker: "James", text: "I've been cleaning county-level data at the Sheps Center, so that sounds like a good fit." },
        { speaker: "Angela Brooks", text: "Perfect. You'd also help run two community listening sessions in Hillsborough and Chapel Hill." },
        { speaker: "James", text: "What do you need from me to move forward?" },
        { speaker: "Angela Brooks", text: "The practicum form and a writing sample. I'll send you our last report so you can see the format." },
      ],
    },
  },
  {
    title: "Sheps Center lab meeting",
    daysAgo: 5,
    kind: "calendar",
    text:
      "Lab meeting with Dr. Elena Ruiz and Marcus Webb. OB unit closures: two more counties to recode. Poster abstract for spring — Dr. Ruiz will co-author. Marcus offered an intro to his NC Medicaid practicum supervisor.",
    participants: ["Dr. Elena Ruiz", "Marcus Webb"],
    interactionType: "meeting",
    topics: ["research", "poster"],
    meeting: {
      durationMin: 41,
      summary:
        "The team reviewed the rural OB unit closures analysis. Two counties need recoding before the dataset is final. Dr. Ruiz confirmed she'll co-author a spring conference poster with James, and Marcus offered to introduce James to his NC Medicaid practicum supervisor.",
      keyPoints: [
        "Two counties need recoding in the closures dataset",
        "Spring conference poster with Dr. Ruiz as co-author",
        "Marcus can introduce James to NC Medicaid",
      ],
      decisions: ["Submit a poster abstract to the spring conference"],
      actionItems: [
        { text: "Send Dr. Ruiz the cleaned OB unit closures dataset", owner: "James" },
        { text: "Draft the poster abstract", owner: "James" },
        { text: "Introduce James to the NC Medicaid practicum supervisor", owner: "Marcus Webb" },
      ],
      openQuestions: [{ text: "Should the poster include the travel-time analysis or save it for the paper?", askedBy: "Dr. Elena Ruiz" }],
      transcript: [
        { speaker: "Dr. Elena Ruiz", text: "The closures trend is clear. Once those two counties are recoded, I think this is a poster." },
        { speaker: "James", text: "I'd love to submit it. Would you be willing to co-author?" },
        { speaker: "Dr. Elena Ruiz", text: "Of course. Draft the abstract and we'll go back and forth on it." },
        { speaker: "Marcus Webb", text: "If you're thinking about policy internships, my practicum supervisor at NC Medicaid would like this work. I can introduce you." },
        { speaker: "James", text: "That would be amazing — thank you." },
      ],
    },
  },
  {
    title: "HPM study group",
    daysAgo: 3,
    kind: "text",
    text:
      "Study group with Maya Patel, Andre Williams and Chloe Bennett. Split the Minority Health Conference abstract — I owe Maya the methods paragraph. Andre will check my regression code. Chloe is recruiting conference volunteers.",
    participants: ["Maya Patel", "Andre Williams", "Chloe Bennett"],
    interactionType: "in_person",
    topics: ["study group", "Minority Health Conference"],
  },
];

/* ------------------------------------------------------------------------ opportunities */

export const GILLINGS_OPPORTUNITIES: DemoOpportunity[] = [
  { person: "Priya Raman", kind: "referral", label: "Referral to RTI's summer 2027 health policy internship", status: "in_progress", direction: "they_offer", dueInDays: 17, excerpt: "She'll refer me once my resume shows the Sheps work." },
  { person: "Keisha Johnson", kind: "internship", label: "NC Medicaid undergraduate policy internship", status: "open", direction: "you_ask", dueInDays: 80, excerpt: "Two undergraduate policy interns each summer; the posting goes up in January." },
  { person: "Samuel Grant", kind: "internship", label: "Duke-Margolis summer undergraduate internship", status: "in_progress", direction: "you_ask", dueInDays: 16, excerpt: "He'll flag my Duke-Margolis application to the program lead." },
  { person: "Angela Brooks", kind: "internship", label: "Community health assessment practicum, summer 2027", status: "in_progress", direction: "they_offer", dueInDays: 1, excerpt: "Orange County is doing its community health assessment next summer and needs a student analyst." },
  { person: "Dr. Elena Ruiz", kind: "collaboration", label: "Co-authored poster on rural OB unit closures", status: "in_progress", direction: "they_offer", dueInDays: 30, excerpt: "She thinks the OB closures findings could be a poster at the spring conference." },
  { person: "Dr. Rebecca Stone", kind: "mentor", label: "Recommendation letter for summer applications", status: "open", direction: "you_ask", dueInDays: 6, excerpt: "She'll write a recommendation letter — send a one-paragraph summary and the posting." },
  { person: "Marcus Webb", kind: "introduction", label: "Intro to his NC Medicaid practicum supervisor", status: "open", direction: "they_offer", excerpt: "Offered to introduce me to his practicum supervisor at NC Medicaid." },
  { person: "Nia Thompson", kind: "internship", label: "Blue Cross NC population health analytics internship", status: "open", direction: "you_ask", dueInDays: 30, excerpt: "Her team takes an analytics intern each summer; applications close November 15." },
  { person: "Hannah Kim", kind: "internship", label: "FHI 360 spring research internship", status: "open", direction: "they_offer", dueInDays: 14, excerpt: "Posted the spring research intern listing and tagged me." },
  { person: "Ethan Park", kind: "job", label: "Part-time analyst at CareBridge Analytics", status: "open", direction: "they_offer", excerpt: "CareBridge needs a part-time analyst who understands rural clinics." },
  { person: "Sofia Alvarez", kind: "mentor", label: "Monthly mentoring through the Gillings alumni program", status: "landed", direction: "they_offer", excerpt: "Meets with me once a month." },
];

/* ------------------------------------------------------------------ radar: moves + posts */

export const GILLINGS_CAREER_MOVES: DemoCareerMove[] = [
  { person: "Keisha Johnson", kind: "title_change", fromOrg: NCDHHS, fromTitle: "Policy Analyst, NC Medicaid", toOrg: NCDHHS, toTitle: "Senior Policy Analyst, NC Medicaid", daysAgo: 4 },
  { person: "Nia Thompson", kind: "joined", fromOrg: UNC_HEALTH, fromTitle: "Senior Data Analyst", toOrg: BCBS, toTitle: "Manager, Population Health Analytics", daysAgo: 6 },
  { person: "Priya Raman", kind: "title_change", fromOrg: RTI, fromTitle: "Research Assistant", toOrg: RTI, toTitle: "Research Analyst, Health Policy", daysAgo: 20 },
  { person: "Samuel Grant", kind: "joined", fromOrg: "NC Institute of Medicine", fromTitle: "Research Assistant", toOrg: DUKE, toTitle: "Research Associate, Duke-Margolis Institute for Health Policy", daysAgo: 45 },
];

export const GILLINGS_SIGNALS: DemoSignal[] = [
  { person: "Priya Raman", daysAgo: 2, excerpt: "RTI's health policy program is taking summer 2027 interns — applications open Nov 1. Gillings students, message me!" },
  { person: "Keisha Johnson", daysAgo: 4, excerpt: "Thrilled to start as Senior Policy Analyst at NC Medicaid, and to help pick this year's summer policy interns." },
  { person: "Nia Thompson", daysAgo: 6, excerpt: "Excited to join Blue Cross NC's population health analytics team. We're hiring a summer intern!" },
  { person: "Hannah Kim", daysAgo: 1, excerpt: "FHI 360 is hiring a global health research intern for spring — link in comments." },
];

/* ------------------------------------------------------------------------- goal fit */

export const GILLINGS_GOAL_FIT: { person: string; goal: string; why: string }[] = [
  { person: "Priya Raman", goal: GOAL_INTERNSHIP, why: "Will refer you to RTI's summer health policy internship." },
  { person: "Keisha Johnson", goal: GOAL_INTERNSHIP, why: "On NC Medicaid's summer intern hiring panel." },
  { person: "Samuel Grant", goal: GOAL_INTERNSHIP, why: "Will flag your Duke-Margolis internship application." },
  { person: "Angela Brooks", goal: GOAL_INTERNSHIP, why: "Offering a summer practicum on the county health assessment." },
  { person: "Lauren Price", goal: GOAL_INTERNSHIP, why: "Runs mock interviews and the Gillings internship database." },
  { person: "Sofia Alvarez", goal: GOAL_MENTORS, why: "Your monthly alumni mentor at UNC Health." },
  { person: "Dr. Rebecca Stone", goal: GOAL_MENTORS, why: "Offered to write your recommendation letter." },
  { person: "Dr. Elena Ruiz", goal: GOAL_RESEARCH, why: "Co-authoring your spring poster on rural OB unit closures." },
  { person: "Dr. Elena Ruiz", goal: GOAL_MENTORS, why: "Your research supervisor at the Sheps Center." },
  { person: "Maya Patel", goal: GOAL_RESEARCH, why: "Co-writing your Minority Health Conference abstract." },
  { person: "Mark Holmes", goal: GOAL_RESEARCH, why: "Directs the Sheps Center, where your poster research happens." },
];

/* ------------------------------------------------------------------------ owner profile */

/** Written after the purge (which wipes these) by `scripts/seed-demo-workspace.ts`. */
export const GILLINGS_OWNER = {
  senderBio:
    "I'm a junior in the BSPH Health Policy & Management program at UNC's Gillings School of Global Public Health, and an undergraduate research assistant at the Cecil G. Sheps Center, where I work on rural hospital and OB unit closures. I'm looking for a summer 2027 health policy internship in the Triangle.",
  schools: [UNC],
  careerProfile: {
    profile: {
      headline: "BSPH Health Policy & Management '28 · UNC Gillings · Undergraduate RA at the Sheps Center",
      summary: "Public health student focused on rural health access, Medicaid policy and health services research.",
      industry: "Public Health",
      location: "Chapel Hill, NC",
    },
    role: { title: "Undergraduate Research Assistant", company: SHEPS },
    skills: ["Health policy analysis", "Stata", "R", "Policy memo writing", "Health services research", "Community health assessment"],
    roleKeywords: ["Health Policy Intern", "Policy Analyst Intern", "Research Assistant", "Public Health Intern"],
  },
  targetCompanies: [RTI, NCDHHS, DUKE, BCBS, UNC_HEALTH, "FHI 360"],
};
