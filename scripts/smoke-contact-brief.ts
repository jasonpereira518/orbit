/**
 * The contact brief's deterministic parts — recent discussions and staleness — must work
 * with no AI key at all, and the store path must write them even when the model call fails.
 * Writes to local PGlite. Stop the worktree dev server first.
 * Run: npx tsx scripts/smoke-contact-brief.ts
 */
import "./smoke/_env";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-brief";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-brief";
// Force the no-key fallback path: local dev may carry provider keys in .env.local.
delete process.env.GEMINI_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactBriefs, contacts, interactions, userGoals, userSettings } from "../src/db/schema";
import { buildRecentDiscussions, clampStanding, generateAndStoreContactBrief, getContactBrief, goalFitOutOfDate, isBriefStale, sanitizeGoalFit } from "../src/lib/contact-brief";
import { ensureUserSettings } from "../src/lib/user-settings";
import { encrypt } from "../src/lib/crypto";

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

  // Calendar sync logs meetings up to 60 days ahead as interactions, and last_interaction_at
  // only widens. A future meeting must not make every page view regenerate the brief.
  const now = new Date(2026, 8, 19, 12);
  const nextMonth = new Date(2026, 9, 19, 12);
  check("a future meeting does not make a fresh brief stale", !isBriefStale({ generatedAt: new Date(2026, 8, 19, 9) }, nextMonth, now));
  check("…but a day-old brief is re-checked", isBriefStale({ generatedAt: new Date(2026, 8, 18, 9) }, nextMonth, now));
  check("once the meeting has happened, an older brief is stale", isBriefStale({ generatedAt: now }, new Date(2026, 8, 20, 12), new Date(2026, 8, 21, 12)));
}
{
  check("overlong standing is truncated, not rejected", clampStanding("x".repeat(700)).length === 600);
}
{
  const goals = [{ id: "g1" }, { id: "g2" }];
  const items = sanitizeGoalFit(
    [
      { goal_id: "g1", why: "  Runs infra   at Stripe.  " },
      { goal_id: "g1", why: "A duplicate of the same goal." },
      { goal_id: "not-shown", why: "A goal that was never in the prompt." },
      { goal_id: "g2", why: "   " },
    ],
    goals
  );
  check("goal fit keeps only shown goals, once, with a reason", items.length === 1 && items[0].goalId === "g1");
  check("  and collapses whitespace in the reason", items[0].why === "Runs infra at Stripe.");
  check("a missing goal_fit is an empty list, not a crash", sanitizeGoalFit(null, goals).length === 0);
  check("no goals → a fit is never out of date", !goalFitOutOfDate([], null));
  check("a brief never judged against goals is out of date", goalFitOutOfDate(goals, null));
  check("a fit that saw every goal is current", !goalFitOutOfDate(goals, { judged: ["g1", "g2"], items: [] }));
  check("a goal added since makes it out of date", goalFitOutOfDate([...goals, { id: "g3" }], { judged: ["g1", "g2"], items: [] }));
  check("a goal deleted since does not", !goalFitOutOfDate([{ id: "g1" }], { judged: ["g1", "g2"], items: [] }));
}

// A stand-in for Gemini, so the model path runs with no network: counts generateContent
// calls and answers with a well-formed brief. Embedding calls get a vector.
let modelCalls = 0;
let lastBody = "";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/embedContent|batchEmbedContents/.test(url)) {
    return Response.json({ embeddings: [{ values: [0.1, 0.2, 0.3] }] });
  }
  if (/generativelanguage/.test(url)) {
    modelCalls += 1;
    lastBody = typeof init?.body === "string" ? init.body : "";
    const brief: Record<string, unknown> = { summary: "You met Priya at the summit.", standing: "Nothing is open.", next_step: null };
    // Answer the way a sloppy model would when goals are in the prompt: one real goal, the
    // same goal twice, and one id that was never offered.
    const shown = [...lastBody.matchAll(/- ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) — /g)].map((m) => m[1]);
    if (shown.length) {
      brief.goal_fit = [
        { goal_id: shown[0], why: "Runs infra at Larkspur, where you want an intro." },
        { goal_id: shown[0], why: "Same goal again." },
        { goal_id: "00000000-0000-0000-0000-000000000000", why: "A goal that does not exist." },
      ];
    }
    return Response.json({
      candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(brief) }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 60 },
    });
  }
  return realFetch(input, init);
}) as typeof fetch;

async function modelPath() {
  const db = await getDb();
  const user = `${USER}-model`;
  await db.delete(contacts).where(eq(contacts.userId, user));
  await db.delete(userSettings).where(eq(userSettings.userId, user));
  await db.insert(userSettings).values({
    userId: user, aiProvider: "gemini", aiModel: "gemini-3.5-flash", geminiApiKeyEncrypted: encrypt("smoke-brief-fake-key"),
  });
  const [c] = await db.insert(contacts).values({ userId: user, fullName: "Priya Raman", company: "Larkspur", title: "PM" }).returning();
  await db.insert(interactions).values({
    userId: user, contactId: c.id, interactionType: "meeting_note", interactionDate: new Date(2026, 8, 1, 12), aiSummary: "Met at the summit.",
  });

  console.log("\nWith a model: an unchanged brief is never paid for twice");
  await generateAndStoreContactBrief(user, c.id);
  const first = await getContactBrief(user, c.id);
  check("the first brief calls the model", modelCalls === 1, String(modelCalls));
  check("  and remembers what it was asked", Boolean(first?.inputHash) && first?.model === "gemini-3.5-flash");

  await new Promise((r) => setTimeout(r, 5));
  const again = await generateAndStoreContactBrief(user, c.id);
  const second = await getContactBrief(user, c.id);
  check("the same inputs again → no model call", modelCalls === 1, String(modelCalls));
  check("  the brief on file is returned", again?.standing === "Nothing is open.");
  check("  and marked current, so the page stops asking", second!.generatedAt.getTime() > first!.generatedAt.getTime());

  await db.insert(interactions).values({
    userId: user, contactId: c.id, interactionType: "note", interactionDate: new Date(2026, 8, 10, 12), rawNotes: "She offered an intro to her CTO.",
  });
  await generateAndStoreContactBrief(user, c.id);
  check("a new interaction → the model is asked again", modelCalls === 2, String(modelCalls));

  await generateAndStoreContactBrief(user, c.id, { force: true });
  check("an explicit regenerate always asks", modelCalls === 3, String(modelCalls));

  await db.delete(contacts).where(eq(contacts.userId, user));
  await db.delete(userSettings).where(eq(userSettings.userId, user));
}

// --- DB, no AI key ---
async function goalFitPath() {
  const db = await getDb();
  const user = `${USER}-goals`;
  await db.delete(contacts).where(eq(contacts.userId, user));
  await db.delete(userGoals).where(eq(userGoals.userId, user));
  await db.delete(userSettings).where(eq(userSettings.userId, user));
  await db.insert(userSettings).values({
    userId: user, aiProvider: "gemini", aiModel: "gemini-3.5-flash", geminiApiKeyEncrypted: encrypt("smoke-brief-fake-key"),
  });
  const [c] = await db.insert(contacts).values({ userId: user, fullName: "Priya Raman", company: "Larkspur", title: "Infra lead" }).returning();
  await db.insert(interactions).values({
    userId: user, contactId: c.id, interactionType: "meeting_note", interactionDate: new Date(2026, 8, 1, 12), aiSummary: "Met at the summit.",
  });

  console.log("\nGoal fit: judged against the user's goals, and only when they have any");
  const before = modelCalls;
  await generateAndStoreContactBrief(user, c.id);
  const plain = await getContactBrief(user, c.id);
  check("no goals → the prompt does not ask for goal_fit", modelCalls === before + 1 && !lastBody.includes("goal_fit"));
  check("  and nothing was judged, so goalFit is null", plain!.goalFit === null);

  const [gA, gB] = await db
    .insert(userGoals)
    .values([
      { userId: user, text: "Get an intro to a Stripe infra lead", createdAt: new Date(2026, 8, 20) },
      { userId: user, text: "Find a seed investor", createdAt: new Date(2026, 8, 21) },
    ])
    .returning();
  await generateAndStoreContactBrief(user, c.id);
  check("adding goals → the brief is asked again (its inputs changed)", modelCalls === before + 2, String(modelCalls - before));
  check("  and the prompt now asks for goal_fit", lastBody.includes("goal_fit"));
  const fit = (await getContactBrief(user, c.id))!.goalFit;
  check("the fit records every goal it looked at", fit?.judged.length === 2 && fit.judged.includes(gA.id) && fit.judged.includes(gB.id));
  check("  and keeps only the one real, unrepeated goal", fit?.items.length === 1 && fit.items[0].why.startsWith("Runs infra"));

  await generateAndStoreContactBrief(user, c.id);
  check("the same goals and inputs → no model call", modelCalls === before + 2, String(modelCalls - before));

  const [gC] = await db.insert(userGoals).values({ userId: user, text: "Hire a founding designer", createdAt: new Date(2026, 8, 22) }).returning();
  check("a goal added after the fit → it reads as out of date",
    goalFitOutOfDate([gA, gB, gC], (await getContactBrief(user, c.id))!.goalFit));
  await generateAndStoreContactBrief(user, c.id);
  check("  and the next brief is re-judged even though nothing else changed", modelCalls === before + 3, String(modelCalls - before));
  const refit = (await getContactBrief(user, c.id))!.goalFit;
  check("  after which every goal, the new one included, has been judged", refit?.judged.includes(gC.id) === true);
  check("  and it is current again", !goalFitOutOfDate([gA, gB, gC], refit));

  await db.delete(contacts).where(eq(contacts.userId, user));
  await db.delete(userGoals).where(eq(userGoals.userId, user));
  await db.delete(userSettings).where(eq(userSettings.userId, user));
}

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
  check("  a fallback brief is never keyed as current", brief!.inputHash === null);
  const contact = await db.query.contacts.findFirst({ where: eq(contacts.id, c.id) });
  check("contacts.aiSummary still written", Boolean(contact?.aiSummary));

  // Regeneration is an upsert, not a second row.
  await generateAndStoreContactBrief(USER, c.id, { force: true });
  const rows = await db.query.contactBriefs.findMany({ where: eq(contactBriefs.userId, USER) });
  check("upsert keeps one row", rows.length === 1);

  await db.delete(contacts).where(eq(contacts.userId, USER));
  await modelPath();
  await goalFitPath();
  console.log("\nsmoke-contact-brief: all checks passed");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
