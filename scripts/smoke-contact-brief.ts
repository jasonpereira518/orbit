/**
 * The contact brief's deterministic parts — recent discussions and staleness — must work
 * with no AI key at all, and the store path must write them even when the model call fails.
 * Writes to local PGlite. Stop the worktree dev server first.
 * Run: npx tsx scripts/smoke-contact-brief.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-brief";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-brief";
delete process.env.DATABASE_URL;
// Force the no-key fallback path: local dev may carry provider keys in .env.local.
delete process.env.GEMINI_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactBriefs, contacts, interactions, userSettings } from "../src/db/schema";
import { buildRecentDiscussions, clampStanding, generateAndStoreContactBrief, getContactBrief, isBriefStale } from "../src/lib/contact-brief";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-brief-user";
function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

// --- pure ---
{
  const rows = Array.from({ length: 7 }, (_, i) => ({
    id: `i${i}`,
    interactionDate: new Date(2026, 7, 20 - i, 12),
    interactionType: "meeting_note",
    aiSummary: i === 0 ? null : `Summary ${i}. Second sentence that must not appear.`,
    rawNotes: i === 0 ? "Raw first line about the deck\nsecond line" : null,
  }));
  const recent = buildRecentDiscussions(rows);
  check("limited to 5", recent.length === 5);
  check("newest first", recent[0].dateIso === "2026-08-20" && recent[4].dateIso === "2026-08-16");
  check("first sentence of aiSummary", recent[1].line === "Summary 1.");
  check("falls back to first line of rawNotes", recent[0].line === "Raw first line about the deck");
  const empty = buildRecentDiscussions([{ id: "x", interactionDate: new Date(), interactionType: "note", aiSummary: null, rawNotes: "   " }]);
  check("blank interactions dropped", empty.length === 0);
  const long = buildRecentDiscussions([{ id: "x", interactionDate: new Date(), interactionType: "note", aiSummary: null, rawNotes: "a".repeat(300) }]);
  check("line capped at 120 chars", long[0].line.length <= 121);
}
{
  const t0 = new Date(2026, 8, 1, 12);
  const t1 = new Date(2026, 8, 2, 12);
  check("no brief → stale", isBriefStale(null, t0));
  check("brief older than last interaction → stale", isBriefStale({ generatedAt: t0 }, t1));
  check("brief newer → fresh", !isBriefStale({ generatedAt: t1 }, t0));
  check("no interactions → fresh", !isBriefStale({ generatedAt: t0 }, null));
}
{
  check("overlong standing is truncated, not rejected", clampStanding("x".repeat(700)).length === 600);
}

// --- DB, no AI key ---
async function main() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
  const [c] = await db.insert(contacts).values({ userId: USER, fullName: "Sarah Chen", company: "Stripe", title: "PM" }).returning();
  await db.insert(interactions).values([
    { userId: USER, contactId: c.id, interactionType: "meeting_note", interactionDate: new Date(2026, 8, 1, 12), aiSummary: "Talked fundraising and the kickoff." },
    { userId: USER, contactId: c.id, interactionType: "note", interactionDate: new Date(2026, 7, 10, 12), rawNotes: "Met at the summit afterparty." },
  ]);

  const out = await generateAndStoreContactBrief(USER, c.id);
  check("fallback returns a summary", Boolean(out?.summary));
  const brief = await getContactBrief(USER, c.id);
  check("brief row written without AI", brief !== null);
  check("  recent discussions stored", brief!.recentDiscussions.length === 2 && brief!.recentDiscussions[0].line === "Talked fundraising and the kickoff.");
  check("  standing falls back to the paragraph", brief!.standing.length > 0);
  check("  model null on fallback", brief!.model === null);
  const contact = await db.query.contacts.findFirst({ where: eq(contacts.id, c.id) });
  check("contacts.aiSummary still written", Boolean(contact?.aiSummary));

  // Regeneration is an upsert, not a second row.
  await generateAndStoreContactBrief(USER, c.id, { force: true });
  const rows = await db.query.contactBriefs.findMany({ where: eq(contactBriefs.userId, USER) });
  check("upsert keeps one row", rows.length === 1);

  await db.delete(contacts).where(eq(contacts.userId, USER));
  console.log("\nsmoke-contact-brief: all checks passed");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
