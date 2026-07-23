import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../src/db";
import { contacts, recruiters, userRecruiterLinks } from "../src/db/schema";
import { eq } from "drizzle-orm";
import {
  normalizeEmail,
  normalizeFirm,
  normalizePersonName,
  recomputeRecruiterRating,
} from "../src/lib/recruiters";

async function main() {
  const db = await getDb();

  const [c] = await db
    .insert(contacts)
    .values({
      userId: "demo-user",
      fullName: "Sarah Chen",
      company: "OpenAI",
      title: "Codex partnerships",
      relationshipScore: 3,
      source: "seed",
      howMet: "AWS Summit",
      aiSummary:
        "Met at AWS Summit; discussed Codex and Case Closed demo.",
      notes: "Follow up with demo in 2 weeks",
      nextFollowUpAt: new Date(Date.now() + 14 * 86400000),
    })
    .returning();

  console.log("created contact", c.id, c.fullName);

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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
