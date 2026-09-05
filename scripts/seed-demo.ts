import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../src/db";
import {
  contacts,
  interactions,
  recruiters,
  userRecruiterLinks,
} from "../src/db/schema";
import { and, eq } from "drizzle-orm";
import {
  normalizeEmail,
  normalizeFirm,
  normalizePersonName,
  recomputeRecruiterRating,
} from "../src/lib/recruiters";

const DEMO_USER = "demo-user";
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000);

/**
 * Insert a demo contact once.
 *
 * The recruiters below have always been idempotent; the contacts were not, so every re-run
 * added another Sarah Chen. That only mattered when nobody re-ran the seed — now that there
 * is a second contact to pick up, re-running is the normal way to get it.
 */
async function upsertContact(
  db: Awaited<ReturnType<typeof getDb>>,
  values: typeof contacts.$inferInsert
) {
  const existing = await db.query.contacts.findFirst({
    where: and(
      eq(contacts.userId, DEMO_USER),
      eq(contacts.fullName, values.fullName)
    ),
  });
  if (existing) {
    console.log("contact exists", existing.fullName);
    return existing;
  }
  const [created] = await db.insert(contacts).values(values).returning();
  console.log("created contact", created.id, created.fullName);
  return created;
}

async function main() {
  const db = await getDb();

  await upsertContact(db, {
    userId: DEMO_USER,
    fullName: "Sarah Chen",
    company: "OpenAI",
    title: "Codex partnerships",
    relationshipScore: 3,
    source: "seed",
    howMet: "AWS Summit",
    aiSummary: "Met at AWS Summit; discussed Codex and Case Closed demo.",
    notes: "Follow up with demo in 2 weeks",
    nextFollowUpAt: new Date(Date.now() + 14 * 86400000),
  });

  // Marcus Webb is already one of the seven people named on the landing page — he is Megrez
  // in the constellation figure, and the reminders visual shows him as "MW · Coffee chat,
  // 3 weeks ago · Drifting". He just was not in the demo data, so the app the landing page
  // sells did not contain him. This is that same person, with the same facts:
  // one in-person coffee three weeks back, and nothing scheduled since — which is what makes
  // him read as drifting rather than merely quiet.
  const marcus = await upsertContact(db, {
    userId: DEMO_USER,
    fullName: "Marcus Webb",
    firstName: "Marcus",
    lastName: "Webb",
    company: "Linear",
    title: "Engineering lead",
    relationshipScore: 3,
    statedCloseness: 3,
    source: "seed",
    howMet: "Introduced by Sarah Chen",
    metContext: "Coffee near their office",
    aiSummary:
      "Engineering lead at Linear, introduced by Sarah Chen. Last caught up over coffee three weeks ago.",
    keyFacts: [
      "Introduced by Sarah Chen",
      "Hiring two senior engineers this quarter",
    ],
    sharedInterests: ["Developer tooling", "Hiring"],
    notes: "Owes me a look at their onboarding flow.",
    dateMet: daysAgo(21),
    firstInteractionAt: daysAgo(21),
    lastInteractionAt: daysAgo(21),
    // Deliberately no `nextFollowUpAt`: the landing page shows him drifting, and a scheduled
    // follow-up is exactly the thing that would stop him drifting.
  });

  const marcusInteraction = await db.query.interactions.findFirst({
    where: and(
      eq(interactions.userId, DEMO_USER),
      eq(interactions.contactId, marcus.id)
    ),
  });
  if (!marcusInteraction) {
    await db.insert(interactions).values({
      userId: DEMO_USER,
      contactId: marcus.id,
      interactionType: "in_person",
      interactionDate: daysAgo(21),
      source: "seed",
      aiSummary:
        "Coffee near their office. Talked through their hiring plan and what they are building next.",
      rawNotes:
        "Coffee with Marcus. They are hiring two senior engineers this quarter and asked whether I knew anyone. Offered to look at their onboarding flow.",
    });
    console.log("created interaction for", marcus.fullName);
  }

  const seedRecruiters = [
    {
      fullName: "Alex Rivera",
      firm: "Rivera Talent",
      specialty: ["Engineering", "AI"],
      email: "alex@riveratalent.example",
      linkedinUrl: "https://www.linkedin.com/in/alex-rivera-talent",
      phone: "+1-555-0101",
    },
    {
      fullName: "Morgan Blake",
      firm: "Insight Global",
      specialty: ["Product", "Design"],
      email: "morgan.blake@insightglobal.example",
      linkedinUrl: null,
      phone: null,
    },
    {
      fullName: "Priya Nair",
      firm: "Harvey Nash",
      specialty: ["Data", "ML"],
      email: "priya.nair@harveynash.example",
      linkedinUrl: "https://www.linkedin.com/in/priya-nair-recruiter",
      phone: "+1-555-0199",
    },
  ];

  for (const r of seedRecruiters) {
    const existing = await db.query.recruiters.findFirst({
      where: eq(
        recruiters.emailNormalized,
        normalizeEmail(r.email)!
      ),
    });
    if (existing) {
      console.log("recruiter exists", existing.fullName);
      continue;
    }
    const [created] = await db
      .insert(recruiters)
      .values({
        fullName: r.fullName,
        nameNormalized: normalizePersonName(r.fullName),
        firm: r.firm,
        firmNormalized: normalizeFirm(r.firm),
        specialty: r.specialty,
        email: r.email,
        emailNormalized: normalizeEmail(r.email),
        linkedinUrl: r.linkedinUrl,
        phone: r.phone,
        avgRating: 0,
        ratingCount: 0,
        logCount: 0,
      })
      .returning();
    console.log("created recruiter", created.id, created.fullName);
  }

  // Link demo user to Alex so PII is unlocked for them
  const alex = await db.query.recruiters.findFirst({
    where: eq(recruiters.emailNormalized, "alex@riveratalent.example"),
  });
  if (alex) {
    const link = await db.query.userRecruiterLinks.findFirst({
      where: eq(userRecruiterLinks.recruiterId, alex.id),
    });
    if (!link) {
      await db.insert(userRecruiterLinks).values({
        userId: "demo-user",
        recruiterId: alex.id,
        status: "active",
        personalRating: 5,
        notes: "Great for senior eng roles",
        source: "manual",
      });
      await recomputeRecruiterRating(alex.id);
      console.log("linked demo-user to", alex.fullName);
    }
  }

  const list = await db
    .select()
    .from(contacts)
    .where(eq(contacts.userId, "demo-user"));
  console.log("contact count", list.length);

  const recCount = await db.select().from(recruiters);
  console.log("recruiter count", recCount.length);
}

main()
  .then(() => {
    // PGlite keeps a handle open, so without this the script finishes its work and then hangs
    // forever instead of exiting.
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
