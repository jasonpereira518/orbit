/**
 * A brief refresh with no usable AI still stores the plain-language brief, and now SAYS the
 * AI was refused (Sprint B, B2) instead of reading as a fresh AI summary.
 *
 * Run: npx tsx scripts/smoke-brief-ai-refusal.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

const USER = "smoke-brief-refusal";
let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

run(async () => {
  const { eq } = await import("drizzle-orm");
  const { getDb } = await import("../src/db");
  const { contactBriefs, contacts, userSettings } = await import("../src/db/schema");
  const { generateAndStoreContactBrief } = await import("../src/lib/contact-brief");
  const db = await getDb();
  const clean = async () => {
    await db.delete(contactBriefs).where(eq(contactBriefs.userId, USER));
    await db.delete(contacts).where(eq(contacts.userId, USER));
    await db.delete(userSettings).where(eq(userSettings.userId, USER));
  };
  await clean();
  await db.insert(userSettings).values({ userId: USER, lifetimePurchasedAt: new Date("2026-01-01T00:00:00Z") });
  const [c] = await db.insert(contacts).values({ userId: USER, fullName: "Bo Brief", firstName: "Bo", lastName: "Brief", notes: "Met at a fair" }).returning();
  try {
    const out = await generateAndStoreContactBrief(USER, c.id, { force: true });
    check("the plain-language brief is still stored", Boolean(out?.summary));
    check("…and the refusal is reported", typeof out?.aiError === "string" && /API key/.test(out!.aiError!), out);

    // A refused refresh must not replace a brief the model already wrote with template text.
    const AI = "Omar leads platform work at Brightline and wants intros to infra founders.";
    const [o] = await db.insert(contacts).values({ userId: USER, fullName: "Omar Haddad", firstName: "Omar", lastName: "Haddad", title: "software engineer", company: "Brightline Systems", howMet: "Career fair", aiSummary: AI }).returning();
    const stamp = new Date("2026-09-01T00:00:00Z");
    const goalFit = { judged: [], items: [] };
    await db.insert(contactBriefs).values({ contactId: o.id, userId: USER, standing: "Warm; spoke last month.", nextStep: "Send the infra intro list", recentDiscussions: [], generatedAt: stamp, model: "claude-sonnet", inputHash: "abc123", goalFit });
    const before = await db.query.contactBriefs.findFirst({ where: eq(contactBriefs.contactId, o.id) });
    const kept = await generateAndStoreContactBrief(USER, o.id, { force: true });
    const after = await db.query.contactBriefs.findFirst({ where: eq(contactBriefs.contactId, o.id) });
    const row = await db.query.contacts.findFirst({ where: eq(contacts.id, o.id), columns: { aiSummary: true } });
    check("refused refresh over an AI brief reports the refusal", typeof kept?.aiError === "string" && /API key/.test(kept!.aiError!), kept);
    check("…returns the AI summary on file", kept?.summary === AI, kept?.summary);
    check("…returns the standing/next step on file", kept?.standing === before?.standing && kept?.nextStep === before?.nextStep, kept);
    check("…leaves contacts.aiSummary untouched", row?.aiSummary === AI, row?.aiSummary);
    check("…leaves the brief row untouched", JSON.stringify(after) === JSON.stringify(before), { before, after });
  } finally {
    await clean();
  }
  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nbrief-ai-refusal: ok");
  process.exit(0);
});
