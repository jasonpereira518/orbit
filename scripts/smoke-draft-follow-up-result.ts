/**
 * A follow-up draft that AI cannot run for returns the refusal as data, so the sheet can show
 * the shared notice; thrown, production digests it into a generic failure.
 *
 * Run: npx tsx scripts/smoke-draft-follow-up-result.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

const USER = "smoke-draft-result";
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
  const { draftFollowUpResult } = await import("../src/lib/follow-up-drafts");
  const db = await getDb();
  const clean = async () => {
    await db.delete(contacts).where(eq(contacts.userId, USER));
    await db.delete(userSettings).where(eq(userSettings.userId, USER));
  };
  await clean();
  // Lifetime with no key: refused as key_required whatever keys the environment holds.
  await db.insert(userSettings).values({ userId: USER, lifetimePurchasedAt: new Date("2026-01-01T00:00:00Z") });
  const [c] = await db.insert(contacts).values({ userId: USER, fullName: "Ada Draft", firstName: "Ada", lastName: "Draft" }).returning();
  try {
    const res = await draftFollowUpResult(USER, c.id, [], {});
    check("an AI refusal comes back as { ok: false } with the shared copy", res.ok === false && /API key/.test(res.error), res);
  } finally {
    await clean();
  }
  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\ndraft-follow-up-result: ok");
  process.exit(0);
});
