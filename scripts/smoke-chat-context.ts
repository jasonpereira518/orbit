/**
 * Pins the chat retrieval context in `src/lib/chat-context.ts`: what the model is shown,
 * assembled with the independent lookups running side by side.
 *
 * The retrieval chain used to run strictly in sequence — search, then rosters, then the
 * attention brief, then recruiters — even though only the knowledge snippets depend on the
 * search results. The shape is asserted here so the streaming route and the server action
 * cannot drift apart, and so the roster people stay eligible as recommendations.
 *
 * Runs against a throwaway PGlite database (keyword search; no AI key, no pgvector).
 * Run: npx tsx scripts/smoke-chat-context.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions } from "../src/db/schema";
import { prepareChatContext } from "../src/lib/chat-context";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-chat-context-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function main() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await ensureUserSettings(USER);
  const rows = await db
    .insert(contacts)
    .values([
      { userId: USER, fullName: "Ada Lovelace", company: "Acme", title: "Engineer", notes: "Met at the Acme summit." },
      { userId: USER, fullName: "Grace Hopper", company: "Acme", title: "Founder" },
      { userId: USER, fullName: "Alan Turing", company: "Bletchley", title: "Researcher" },
    ])
    .returning();
  const ada = rows[0].id;
  await db.insert(interactions).values({
    userId: USER,
    contactId: ada,
    interactionType: "linkedin_message",
    rawNotes: "Thanks for the intro, let's talk Tuesday.",
    interactionDate: new Date(),
  });

  const ctx = await prepareChatContext(USER, "Who do I know at Acme?", {});
  check("the question is carried trimmed", ctx.q === "Who do I know at Acme?");
  check("retrieval finds the Acme people", ctx.retrieved.some((c) => c.fullName === "Ada Lovelace"), JSON.stringify(ctx.retrieved.map((c) => c.fullName)));
  const acme = ctx.orgRosters.find((r) => r.name.toLowerCase() === "acme");
  check("the Acme roster is exhaustive (2 people)", acme?.total === 2, JSON.stringify(ctx.orgRosters));
  check("roster people are eligible recommendations", Boolean(acme) && acme!.people.every((p) => ctx.allowedContacts.has(p.id)));
  check("snippets exist for every retrieved contact", ctx.retrieved.every((c) => ctx.snippets.has(c.id)));
  check("Ada's LinkedIn message is a snippet", (ctx.snippets.get(ada)?.recentMessages ?? []).some((m) => /Tuesday/.test(m)));
  check("no focus: the question is passed through unscoped", ctx.scopedQuestion === ctx.q);
  check("no thread: no prior turns", ctx.priorTurns.length === 0 && ctx.thread === null);
  check("model context rows carry recent messages", ctx.modelContacts.find((c) => c.id === ada)?.recentMessages.length === 1);

  const focused = await prepareChatContext(USER, "What did we last discuss?", { focusContactId: ada });
  check("focus: the pinned contact leads the list with relevance 1", focused.retrieved[0]?.id === ada && focused.retrieved[0]?.relevance === 1);
  check("focus: the question is scoped to the pinned contact", focused.scopedQuestion.includes(ada) && focused.scopedQuestion.endsWith("What did we last discuss?"));
  check("focus: the pinned contact's interactions are the snippets", (focused.snippets.get(ada)?.recentMessages ?? []).length >= 1);

  const filtered = ctx.filterRecommendations([
    { contact_id: ada, recruiter_id: null, name: "Ada", reason: "r", suggested_action: "a", draft_message: null },
    { contact_id: "not-a-real-id", recruiter_id: null, name: "Ghost", reason: "r", suggested_action: "a", draft_message: null },
  ]);
  check("recommendations are filtered to people the user actually has", filtered.length === 1 && filtered[0].contact_id === ada);

  await db.delete(contacts).where(eq(contacts.userId, USER));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll chat-context checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
