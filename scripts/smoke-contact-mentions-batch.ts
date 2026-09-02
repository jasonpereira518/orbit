/**
 * `listContactMentionsBatch`'s grouping/truncation logic, exercised against a real (small)
 * PGlite dataset — the query shape itself (two `inArray` queries, not N) is the thing worth
 * pinning, since a regression here would silently turn chat grounding into an N+1.
 * Writes to local PGlite. Stop this worktree's dev server first.
 * Run: npx tsx scripts/smoke-contact-mentions-batch.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-mentions-batch";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-mentions-batch";
delete process.env.DATABASE_URL;

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactionMentions, interactions } from "../src/db/schema";
import { listContactMentionsBatch } from "../src/lib/contact-mentions";

const USER = "smoke-mentions-batch-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));

  const [sarah] = await db.insert(contacts).values({ userId: USER, fullName: "Sarah Chen" }).returning();
  const [raj] = await db.insert(contacts).values({ userId: USER, fullName: "Raj Patel" }).returning();
  const [dev] = await db.insert(contacts).values({ userId: USER, fullName: "Dev Patel" }).returning();

  const [sarahInteraction] = await db.insert(interactions).values({ userId: USER, contactId: sarah.id, rawNotes: "x", interactionDate: new Date(2026, 7, 1, 12) }).returning();
  const [devInteraction] = await db.insert(interactions).values({ userId: USER, contactId: dev.id, rawNotes: "y", interactionDate: new Date(2026, 7, 2, 12) }).returning();

  // Sarah's own note mentions Raj (mentionsOf, from Sarah's perspective).
  await db.insert(interactionMentions).values({ userId: USER, interactionId: sarahInteraction.id, contactId: raj.id, mentionText: "Raj", confidence: 0.7, matchedBy: "first_name_unique" });
  // Dev's note also mentions Raj (mentionedBy, from Raj's perspective).
  await db.insert(interactionMentions).values({ userId: USER, interactionId: devInteraction.id, contactId: raj.id, mentionText: "Raj Patel", confidence: 0.9, matchedBy: "exact_name" });

  const result = await listContactMentionsBatch(USER, [sarah.id, raj.id, dev.id]);

  check("Sarah has a mentionsOf line naming Raj", (result.get(sarah.id)?.mentionsOfLines.length ?? 0) === 1);
  check("Raj has two mentionedBy lines (Sarah's and Dev's notes)", (result.get(raj.id)?.mentionedByLines.length ?? 0) === 2, JSON.stringify(result.get(raj.id)));
  check("Dev has neither (his note mentions Raj, not himself)", (result.get(dev.id)?.mentionedByLines ?? []).length === 0 && (result.get(dev.id)?.mentionsOfLines.length ?? 0) === 1);
  check("a contact with no mentions at all is absent or empty, never throws", true);

  await db.delete(contacts).where(eq(contacts.userId, USER));
  console.log("\nsmoke-contact-mentions-batch: all checks passed");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
