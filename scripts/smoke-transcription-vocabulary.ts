/**
 * `loadNetworkVocabulary` against a real database.
 *
 * `scripts/smoke-wispr.ts` covers the selection and the caps as pure functions. The part
 * that can only be checked against Postgres is the ORDER BY, and it is the part most
 * likely to be wrong: every engine truncates this list, so if the ordering puts
 * never-contacted rows first, the cap drops exactly the people the user just met. A plain
 * `DESC` on a nullable timestamp does that, because NULL sorts high in Postgres — hence
 * the explicit NULLS LAST that this exists to pin.
 *
 * Run: npx tsx scripts/smoke-transcription-vocabulary.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { loadNetworkVocabulary } from "../src/lib/transcription-vocabulary";

const USER = "smoke-vocab-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

  await db.insert(contacts).values([
    {
      userId: USER,
      fullName: "Priya Raman",
      company: "Stripe",
      school: "IIT Bombay",
      lastInteractionAt: daysAgo(1),
    },
    {
      userId: USER,
      fullName: "Kenji Watanabe",
      company: "Notion",
      lastInteractionAt: daysAgo(400),
    },
    // The trap: never interacted with. A plain DESC sorts this NULL to the FRONT.
    { userId: USER, fullName: "Never Metperson", company: "Ghostco" },
  ]);

  console.log("\nloadNetworkVocabulary");

  const terms = await loadNetworkVocabulary(USER);

  check("returns terms for a user with contacts", terms.length > 0, `${terms.length}`);
  check("includes whole names", terms.includes("Priya Raman"), terms.join("|"));
  check("includes companies", terms.includes("Stripe"));
  check("includes schools", terms.includes("IIT Bombay"));
  check("includes name parts", terms.includes("Priya") && terms.includes("Raman"));

  // The assertion this file exists for.
  check(
    "the most recently seen contact comes first",
    terms[0] === "Priya Raman",
    terms.slice(0, 3).join("|"),
  );
  check(
    "a never-contacted row sorts last, not first",
    terms.indexOf("Never Metperson") > terms.indexOf("Kenji Watanabe"),
    terms.slice(0, 4).join("|"),
  );

  // ── Isolation and empty cases ─────────────────────────────────────────────────────────
  console.log("\nscoping");

  check(
    "a user with no contacts gets an empty list, not an error",
    (await loadNetworkVocabulary("smoke-vocab-nobody")).length === 0,
  );

  {
    // Another user's network must never leak into this one's dictionary — it would be sent
    // to a third-party transcription API.
    const other = "smoke-vocab-other";
    await db.delete(contacts).where(eq(contacts.userId, other));
    await db.insert(contacts).values({
      userId: other,
      fullName: "Someone Elsewhere",
      company: "OtherCorp",
    });
    const mine = await loadNetworkVocabulary(USER);
    check("never returns another user's contacts", !mine.includes("Someone Elsewhere"), mine.join("|"));
    check("never returns another user's companies", !mine.includes("OtherCorp"));
    await db.delete(contacts).where(eq(contacts.userId, other));
  }

  check("respects an explicit limit", (await loadNetworkVocabulary(USER, 2)).length === 2);
  check("a limit of 0 returns nothing", (await loadNetworkVocabulary(USER, 0)).length === 0);

  await db.delete(contacts).where(eq(contacts.userId, USER));

  console.log("\nsmoke-transcription-vocabulary: all checks passed");
}

async function cleanup() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, "smoke-vocab-other"));
}

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error("\n" + e.message);
    await cleanup().catch(() => {});
    process.exit(1);
  });
