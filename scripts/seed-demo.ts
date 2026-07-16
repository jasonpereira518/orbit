import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { eq } from "drizzle-orm";

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

  console.log("created", c.id, c.fullName);
  const list = await db
    .select()
    .from(contacts)
    .where(eq(contacts.userId, "demo-user"));
  console.log("count", list.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
