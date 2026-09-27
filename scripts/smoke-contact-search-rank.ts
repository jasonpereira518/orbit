/**
 * Searching "Priya" ranks people named Priya first; someone whose notes merely mention her
 * is dropped from a name lookup but still found by a word that only their notes contain.
 * Fixture from the 2026-09-15 audit (Hassan Ali appeared beside exact-name hits).
 * Run: npx tsx scripts/smoke-contact-search-rank.ts
 */
import "./smoke/_env";

import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { hybridSearchContacts } from "../src/lib/hybrid-search";
import { contactSearchCondition, nameMatchTier, nameMatchTierSql } from "../src/lib/contact-search-rank";
import { run } from "./smoke/_env";

const U = "smoke-contact-search-rank-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

run(async () => {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, U));
  await db.insert(contacts).values([
    { userId: U, fullName: "Priya Raman", company: "Loom", title: "Head of Growth" },
    { userId: U, fullName: "Priyanka Das", company: "Figma" },
    { userId: U, fullName: "Hassan Ali", company: "Acme", notes: "Met through Priya at the Durham founders dinner." },
  ]);

  console.log("Tiers…");
  const tierRows = await db
    .select({ fullName: contacts.fullName, preferredName: contacts.preferredName, tier: nameMatchTierSql("Priya") })
    .from(contacts)
    .where(eq(contacts.userId, U));
  const tiers = Object.fromEntries(tierRows.map((r) => [r.fullName, Number(r.tier)]));
  check("SQL tiers: whole word 0, prefix 1, elsewhere 2", tiers["Priya Raman"] === 0 && tiers["Priyanka Das"] === 1 && tiers["Hassan Ali"] === 2, JSON.stringify(tiers));
  check("JS tiers agree with SQL", tierRows.every((r) => nameMatchTier(r.fullName, r.preferredName, "Priya") === Number(r.tier)));
  check("a full name is a whole-word match", nameMatchTier("Priya Raman", null, "  priya   raman ") === 0);
  check("LIKE metacharacters match literally", nameMatchTier("A_B Corp", null, "a%b") === 2);

  console.log("\nPicker order (name tier, then the alphabetical sort)…");
  const picked = await db
    .select({ fullName: contacts.fullName })
    .from(contacts)
    .where(and(eq(contacts.userId, U), contactSearchCondition("Priya")))
    .orderBy(asc(nameMatchTierSql("Priya")), asc(contacts.sortKey), asc(contacts.fullName), asc(contacts.id));
  check(
    "name hits first, the mention last",
    JSON.stringify(picked.map((r) => r.fullName)) === JSON.stringify(["Priya Raman", "Priyanka Das", "Hassan Ali"]),
    JSON.stringify(picked.map((r) => r.fullName))
  );

  console.log("\nHybrid search…");
  let hits = await hybridSearchContacts(U, { query: "Priya" });
  check(
    "only the two name matches, whole word first",
    JSON.stringify(hits.map((h) => h.fullName)) === JSON.stringify(["Priya Raman", "Priyanka Das"]),
    JSON.stringify(hits.map((h) => [h.fullName, h.matchedArms]))
  );
  hits = await hybridSearchContacts(U, { query: "Durham" });
  check("a word only the notes contain still finds the person", hits.some((h) => h.fullName === "Hassan Ali"), JSON.stringify(hits.map((h) => h.fullName)));
  hits = await hybridSearchContacts(U, { query: "Loom" });
  check("a company match is kept", hits[0]?.fullName === "Priya Raman", JSON.stringify(hits.map((h) => h.fullName)));
});
