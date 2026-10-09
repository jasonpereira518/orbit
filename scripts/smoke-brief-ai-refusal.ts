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
  const { contacts, userSettings } = await import("../src/db/schema");
  const { generateAndStoreContactBrief } = await import("../src/lib/contact-brief");
  const db = await getDb();
  const clean = async () => {
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
