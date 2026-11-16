/**
 * LinkedIn deep read, PR 4: one contact's relationship context, loaded from the digest and the
 * user's own history, and rendered as the short block every prompt and the contact page share.
 *
 * Run: npx tsx scripts/smoke-relationship-context.ts
 */
import "./smoke/_env";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-rel-context";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-rel-context";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, relationshipDigests, userSettings } from "../src/db/schema";
import {
  formatOriginWhen,
  relationshipFactLines,
  loadRelationshipContexts,
  renderRelationshipBlock,
  type RelationshipContext,
} from "../src/lib/relationship-context";
import { ensureUserSettings } from "../src/lib/user-settings";
import { buildProfileBlock } from "../src/lib/follow-up-drafts";
import { run } from "./smoke/_env";

const USER = "smoke-rel-context-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const FULL: RelationshipContext = {
  origin: { text: "Met at HackNC", when: "Sep 2022", excerpt: "so good meeting you at HackNC" },
  kind: "classmate",
  overlaps: ["You both went to State University, 2018 to 2020"],
  topics: ["payments", "fundraising"],
  workingOn: "Raising a seed round",
  openThreads: ["Send the deck"],
};

run(async () => {
  console.log("rendering");
  check("a day", formatOriginWhen("2022-09-17", "day") === "Sep 17, 2022");
  check("a month", formatOriginWhen("2022-09-01", "month") === "Sep 2022");
  check("a year", formatOriginWhen("2022-01-01", "year") === "2022");
  check("no date", formatOriginWhen(null, null) === null);
  const block = renderRelationshipBlock(FULL) ?? "";
  check(
    "a full context renders every line, in order",
    block ===
      [
        "How you met: Met at HackNC (Sep 2022)",
        "Relationship: classmate",
        "You overlapped: You both went to State University, 2018 to 2020",
        "You talk about: payments, fundraising",
        "Working on: Raising a seed round",
        "Open: Send the deck",
      ].join("\n"),
    block
  );
  const empty: RelationshipContext = { origin: null, kind: null, overlaps: [], topics: [], workingOn: null, openThreads: [] };
  check("an empty context renders nothing", renderRelationshipBlock(empty) === null && renderRelationshipBlock(null) === null);
  check("one part renders one line", renderRelationshipBlock({ ...empty, workingOn: "Hiring" }) === "Working on: Hiring");
  const long = renderRelationshipBlock({ ...empty, topics: ["a\nb" + "x".repeat(1000)] }) ?? "";
  check("a long, multi-line part is one capped line", !long.includes("\n") && long.length <= 240, String(long.length));

  check("Radar takes only how you met and the overlap", relationshipFactLines(FULL).join("|") === "How you met: Met at HackNC (Sep 2022)|You overlapped: You both went to State University, 2018 to 2020");
  check("Radar takes nothing from an empty context", relationshipFactLines(empty).length === 0 && relationshipFactLines(undefined).length === 0);

  console.log("\ndrafts");
  const row = { fullName: "Maya Chen", preferredName: null, title: "PM", company: "Stripe", location: null, metContext: null, dateMet: null, howMet: null, aiSummary: null, notes: null, keyFacts: ["Has two kids"] } as unknown as Parameters<typeof buildProfileBlock>[0];
  const today = buildProfileBlock(row);
  check("a draft's profile block ends with the relationship block", buildProfileBlock(row, "How you met: Met at HackNC (Sep 2022)") === `${today}\nHow you met: Met at HackNC (Sep 2022)`);
  check("without one it is today's block", buildProfileBlock(row, null) === today && today.endsWith("Key facts: Has two kids"));

  console.log("\nloading");
  const db = await getDb();
  await db.delete(relationshipDigests).where(eq(relationshipDigests.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
  await db.update(userSettings).set({
    careerProfile: { positions: [{ title: "Engineer", company: "Acme", start: { year: 2021 }, end: { year: 2023 } }] },
  }).where(eq(userSettings.userId, USER));
  const [removed] = await db.insert(contacts).values({ userId: USER, fullName: "Removed Kind", company: "Acme" }).returning();
  await db.insert(relationshipDigests).values({
    contactId: removed.id, userId: USER, summary: "s",
    topics: [{ label: "payments", lastDiscussedAt: "2023-01-01" }],
    origin: { text: "Met at HackNC", date: "2022-09-01", precision: "month", context: "event", excerpt: "so good meeting you", interactionId: removed.id, runId: removed.id, replaced: null },
    relationship: { kind: "recruiter", excerpt: "x y z", interactionId: removed.id, removed: true },
  });
  const [old] = await db.insert(contacts).values({ userId: USER, fullName: "Old Digest" }).returning();
  await db.insert(relationshipDigests).values({ contactId: old.id, userId: USER, summary: "s", topics: [{ label: "hiring", lastDiscussedAt: "2023-01-01" }], workingOn: "Hiring a designer" });

  const got = await loadRelationshipContexts(USER, [removed.id, old.id], { deepRead: true });
  const r = got.get(removed.id);
  check("a removed relationship kind is never shown", r?.kind === null, JSON.stringify(r));
  check("the origin keeps its precision", r?.origin?.text === "Met at HackNC" && r.origin.when === "Sep 2022");
  check("overlap uses the contact's company when it has no history", r?.overlaps.join() === "You both worked at Acme", r?.overlaps.join());
  const o = got.get(old.id);
  check("a digest from before the deep read shows what it has", o?.origin === null && o?.kind === null && o?.topics.join() === "hiring" && o?.workingOn === "Hiring a designer", JSON.stringify(o));
  check("deep read off: nothing is loaded", (await loadRelationshipContexts(USER, [removed.id], { deepRead: false })).size === 0);

  await db.delete(relationshipDigests).where(eq(relationshipDigests.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  console.log("\nsmoke-relationship-context: all checks passed");
});
