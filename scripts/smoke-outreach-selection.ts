/**
 * People listing and selection (spec §7.7). "Select page" and "select all matching" are
 * different operations and must stay so; "all matching" applies to exactly the rows the filter
 * matches minus the exceptions, never to excluded or filtered-out people, and never to anyone
 * already in a conversation. Everything is scoped to the owner.
 *
 * Also covers the controller ruling on `researchOnePerson`: it is check-then-act on
 * `research_state`, so a double-click must not queue two attempts. The claim is one conditional
 * UPDATE — only one of two concurrent calls for the same person can win it.
 *
 * Run: npx tsx scripts/smoke-outreach-selection.ts
 */
import "./smoke/_env";

import { and, eq } from "drizzle-orm";
import { run } from "./smoke/_env";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { createCampaignV2 } from "../src/lib/outreach/campaigns";
import {
  excludePeople,
  listPeople,
  researchOnePerson,
  restorePeople,
  resolveDuplicate,
  selectPeople,
} from "../src/lib/outreach/people";
import { ensureUserSettings } from "../src/lib/user-settings";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const USER = "smoke-selection-user";
const OTHER = "smoke-selection-other";

async function main() {
  const db = await getDb();
  await ensureUserSettings(USER);
  const { id: campaignId } = await createCampaignV2(USER, { brief: { purpose: "Meet partnership leads in fintech", desiredOutcome: "Intro calls" }, channel: "email" });
  const tiers = [...Array(12).fill("strong"), ...Array(10).fill("possible"), ...Array(5).fill("weak"), ...Array(3).fill("filtered")] as const;
  const ids: string[] = [];
  for (const [i, tier] of tiers.entries()) {
    const [row] = await db
      .insert(schema.outreachProspects)
      .values({
        userId: USER, campaignId, externalId: `li:p${i}`, fullName: `Person ${i}`, rankTier: tier,
        rankScore: 1 - i / 100, rankedCriteriaVersion: 0, email: i % 2 === 0 ? `p${i}@x.com` : null,
      })
      // Bare `.returning()`, not `.returning({ id })` — the same drizzle union-`Db`-type trap
      // noted for `.update(...).returning({ col })` elsewhere in this codebase also applies to
      // `.insert(...).returning({ col })` here; it fails typecheck against `getDb()`'s union
      // return type. See the pre-cleared deviation in the task-16 report.
      .returning();
    ids.push(row.id);
  }

  const page1 = await listPeople(USER, campaignId, { limit: 25 });
  check("filtered people are hidden by default", page1.total === 27);
  check("the first page holds 25, in rank order", page1.rows.length === 25 && page1.rows[0].rankTier === "strong" && page1.nextOffset === 25);
  const page2 = await listPeople(USER, campaignId, { limit: 25, offset: 25 });
  check("the second page holds the rest", page2.rows.length === 2 && page2.nextOffset === null);
  check("counts cover the whole campaign",
    page1.counts.strong === 12 && page1.counts.possible === 10 && page1.counts.weak === 5 && page1.counts.filtered === 3);

  const onPage = await selectPeople(USER, campaignId, { scope: "ids", ids: page1.rows.map((r) => r.id), selected: true });
  check("selecting a page selects exactly that page", onPage.changed === 25);
  await selectPeople(USER, campaignId, { scope: "ids", ids, selected: false });

  await excludePeople(USER, campaignId, [ids[0]], "Already know them");
  const [conversationProspect] = [ids[1]];
  await db.insert(schema.outreachConversations).values({
    userId: USER, campaignId, prospectId: conversationProspect, channel: "email", provider: "gmail", providerThreadId: "t-1",
  });
  const all = await selectPeople(USER, campaignId, {
    scope: "filter", filter: { tiers: ["strong", "possible"] }, exceptIds: [ids[2], ids[3]], selected: true,
  });
  check("all matching = 22 strong+possible − 1 excluded − 1 in conversation − 2 exceptions", all.changed === 18, String(all.changed));
  const selected = await listPeople(USER, campaignId, { filter: { selection: "selected" }, limit: 100 });
  check("the selection is exactly those rows", selected.total === 18 && !selected.rows.some((r) => [ids[0], ids[1], ids[2], ids[3]].includes(r.id)));
  check("filtered people are never swept up", selected.rows.every((r) => r.rankTier !== "filtered"));

  const withEmail = await listPeople(USER, campaignId, { filter: { hasEmail: true }, limit: 100 });
  check("the email filter works", withEmail.rows.every((r) => r.email !== null));

  await restorePeople(USER, campaignId, [ids[0]]);
  check("restore brings an excluded person back", (await listPeople(USER, campaignId, { limit: 100 })).total === 27);

  await db.update(schema.outreachProspects).set({ possibleDuplicateOf: ids[4], duplicateReview: "pending" }).where(eq(schema.outreachProspects.id, ids[5]));
  await resolveDuplicate(USER, ids[5], "merged");
  const [merged] = await db.select().from(schema.outreachProspects).where(eq(schema.outreachProspects.id, ids[5]));
  check("merging a duplicate excludes it with the reason", merged.status === "excluded" && merged.duplicateReview === "merged");

  console.log("Tenancy...");
  const intrusion = await selectPeople(OTHER, campaignId, { scope: "filter", filter: {}, exceptIds: [], selected: true });
  check("another user's selection changes nothing", intrusion.changed === 0);
  check("another user's listing is empty", (await listPeople(OTHER, campaignId, { limit: 100 })).total === 0);
  check("another user cannot exclude", (await excludePeople(OTHER, campaignId, ids, null)).changed === 0);
  const untouched = await db
    .select()
    .from(schema.outreachProspects)
    .where(and(eq(schema.outreachProspects.campaignId, campaignId), eq(schema.outreachProspects.status, "excluded")));
  check("…so exclusions are unchanged", untouched.length === 1);

  console.log("researchOnePerson double-claim...");
  // Personal funding needs keys the resolver can decrypt; no network call happens because no
  // job runs in this smoke (allocateResearch only enqueues it).
  await db
    .update(schema.userSettings)
    .set({ braveApiKeyEncrypted: encrypt("fake-brave-key"), apolloApiKeyEncrypted: encrypt("fake-apollo-key") })
    .where(eq(schema.userSettings.userId, USER));
  // Use a prospect outside the selection fixtures' counts so this doesn't disturb them.
  const [raceProspect] = await db
    .insert(schema.outreachProspects)
    .values({ userId: USER, campaignId, externalId: "li:race", fullName: "Race Person", rankTier: "strong", rankScore: 1, rankedCriteriaVersion: 0 })
    // Bare `.returning()` — see the note above.
    .returning();

  const outcomes = await Promise.allSettled([
    researchOnePerson(USER, raceProspect.id, "personal"),
    researchOnePerson(USER, raceProspect.id, "personal"),
  ]);
  const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
  const rejected = outcomes.filter((o) => o.status === "rejected");
  check("exactly one call wins the claim", fulfilled.length === 1, JSON.stringify(outcomes));
  check(
    "the other is rejected as already underway",
    rejected.length === 1 && rejected[0].status === "rejected" && String((rejected[0] as PromiseRejectedResult).reason?.message).includes("already underway")
  );
  const attempts = await db
    .select()
    .from(schema.outreachResearchAttempts)
    .where(and(eq(schema.outreachResearchAttempts.userId, USER), eq(schema.outreachResearchAttempts.prospectId, raceProspect.id)));
  check("exactly one research attempt row was created", attempts.length === 1, String(attempts.length));

  console.log("All outreach selection checks passed.");
}

run(main);
