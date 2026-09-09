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
import { chatMessages, chatThreads, contacts, interactions } from "../src/db/schema";
import { prepareChatContext } from "../src/lib/chat-context";
import { saveContactProfile } from "../src/lib/contact-profile";
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

async function makeContact(fullName: string): Promise<string> {
  const db = await getDb();
  const [row] = await db.insert(contacts).values({ userId: USER, fullName }).returning();
  return row.id;
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
  check(
    "Ada's message reaches the timeline",
    (ctx.snippets.get(ada)?.timeline ?? []).some((m: string) => /Tuesday/.test(m)),
    JSON.stringify(ctx.snippets.get(ada)?.timeline)
  );
  check(
    "and it is dated and labelled, not bare text",
    (ctx.snippets.get(ada)?.timeline ?? []).some((m: string) =>
      /^\d{4}-\d{2}-\d{2} · LinkedIn: /.test(m)
    ),
    JSON.stringify(ctx.snippets.get(ada)?.timeline)
  );
  check("no focus: the question is passed through unscoped", ctx.scopedQuestion === ctx.q);
  check("no thread: no prior turns", ctx.priorTurns.length === 0 && ctx.thread === null);
  check("model context rows carry the timeline", ctx.modelContacts.find((c) => c.id === ada)?.timeline.length === 1);

  const focused = await prepareChatContext(USER, "What did we last discuss?", { focusContactId: ada });
  check("focus: the pinned contact leads the list with relevance 1", focused.retrieved[0]?.id === ada && focused.retrieved[0]?.relevance === 1);
  check("focus: the question is scoped to the pinned contact", focused.scopedQuestion.includes(ada) && focused.scopedQuestion.endsWith("What did we last discuss?"));
  check("focus: the pinned contact's interactions are the snippets", (focused.snippets.get(ada)?.timeline ?? []).length >= 1);

  const filtered = ctx.filterRecommendations([
    { contact_id: ada, recruiter_id: null, name: "Ada", reason: "r", suggested_action: "a", draft_message: null },
    { contact_id: "not-a-real-id", recruiter_id: null, name: "Ghost", reason: "r", suggested_action: "a", draft_message: null },
  ]);
  check("recommendations are filtered to people the user actually has", filtered.length === 1 && filtered[0].contact_id === ada);

  // --- profiles in chat ----------------------------------------------------------
  const profiledId = await makeContact("Katherine Johnson");
  await saveContactProfile(USER, profiledId, {
    source: "extension",
    sourceUrl: "https://www.linkedin.com/in/katherine",
    adapterVersion: "linkedin-2",
    capturedAt: new Date(),
    warnings: [],
    headline: "Trajectories",
    about: "Computed orbital mechanics by hand.",
    skills: [{ name: "Orbital mechanics" }],
    certifications: [],
    volunteering: [],
    publications: [],
    experiences: [
      { kind: "role", organization: "NASA", title: "Mathematician", startYear: 1953,
        startMonth: null, endYear: 1986, endMonth: null, isCurrent: false, location: null,
        description: null, fieldOfStudy: null },
    ],
  });

  const focusedProfile = await prepareChatContext(USER, "what did she work on?", {
    focusContactId: profiledId,
  });
  check(
    "a focused question carries the whole profile",
    focusedProfile.focusProfile?.includes("Computed orbital mechanics by hand.") === true,
    focusedProfile.focusProfile ?? "null"
  );
  check(
    "the focused profile includes dated roles",
    focusedProfile.focusProfile?.includes("NASA") === true &&
      focusedProfile.focusProfile?.includes("1953 – 1986") === true,
    focusedProfile.focusProfile ?? "null"
  );

  const network = await prepareChatContext(USER, "who has worked at NASA?", {});
  const katherine = network.modelContacts.find((c) => c.id === profiledId);
  check("a retrieved contact carries a career line", katherine?.career === "ex-NASA", katherine?.career ?? "null");
  check(
    "a retrieved contact does not carry the whole profile",
    !JSON.stringify(katherine ?? {}).includes("Computed orbital mechanics by hand.")
  );

  // --- who was attached survives a reload ----------------------------------------------
  // The mark on a sent question used to be re-derived from its text by a shape heuristic,
  // because the attachment list was not persisted. This is the round trip that replaced it.

  const thread = (await db.insert(chatThreads).values({ userId: USER }).returning())[0];
  await db.insert(chatMessages).values({
    threadId: thread.id,
    userId: USER,
    role: "user",
    content: "What should I ask @Ada Lovelace next time we speak?",
    attachedContacts: [{ id: ada, name: "Ada Lovelace" }],
  });
  const [savedMsg] = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.threadId, thread.id));
  check(
    "the attached contacts column round-trips",
    savedMsg?.attachedContacts?.[0]?.id === ada &&
      savedMsg?.attachedContacts?.[0]?.name === "Ada Lovelace",
    JSON.stringify(savedMsg?.attachedContacts)
  );

  await db.insert(chatMessages).values({
    threadId: thread.id,
    userId: USER,
    role: "user",
    content: "Who do I know at Acme?",
  });
  const savedMsgs = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.threadId, thread.id));
  check(
    "a question with nothing attached defaults to empty, not null",
    savedMsgs.every((r) => Array.isArray(r.attachedContacts)),
    JSON.stringify(savedMsgs.map((r) => r.attachedContacts))
  );
  await db.delete(chatThreads).where(eq(chatThreads.userId, USER));

  // --- every interaction type reaches a retrieved contact, fairly ---------------------

  const chatty = (
    await db.insert(contacts).values({ userId: USER, fullName: "Chatty Person", company: "Acme" }).returning()
  )[0].id;
  const quiet = (
    await db.insert(contacts).values({ userId: USER, fullName: "Quiet Person", company: "Acme" }).returning()
  )[0].id;
  // 20 recent rows for one, 1 old row for the other. A flat `LIMIT n * perContact` ordered
  // by date hands every slot to the chatty one and the quiet one arrives with nothing.
  await db.insert(interactions).values([
    ...Array.from({ length: 20 }, (_, i) => ({
      userId: USER,
      contactId: chatty,
      interactionType: "in_person",
      rawNotes: `Chatty meeting ${i}`,
      interactionDate: new Date(Date.now() - i * 3_600_000),
    })),
    {
      userId: USER,
      contactId: quiet,
      interactionType: "call",
      rawNotes: "The one call we ever had.",
      interactionDate: new Date(Date.now() - 400 * 86_400_000),
    },
  ]);

  const fair = await prepareChatContext(USER, "Who do I know at Acme?", {});
  check(
    "a coffee reaches the model, not just LinkedIn messages",
    (fair.snippets.get(chatty)?.timeline ?? []).some((l: string) => /In person: Chatty meeting/.test(l)),
    JSON.stringify(fair.snippets.get(chatty)?.timeline?.slice(0, 2))
  );
  check(
    "a quiet contact is not starved by a chatty one",
    (fair.snippets.get(quiet)?.timeline ?? []).some((l: string) => /The one call we ever had/.test(l)),
    JSON.stringify(fair.snippets.get(quiet)?.timeline)
  );
  check(
    "and the chatty one is still capped",
    (fair.snippets.get(chatty)?.timeline ?? []).length <= 8,
    String((fair.snippets.get(chatty)?.timeline ?? []).length)
  );

  // --- a school roster counts alumni who also have jobs --------------------------------

  await db.insert(contacts).values([
    { userId: USER, fullName: "Employed Alum", company: "Ramp", school: "Wossamotta U" },
    { userId: USER, fullName: "Studying Alum", school: "Wossamotta U" },
  ]);
  const schoolCtx = await prepareChatContext(USER, "Who do I know from Wossamotta U?", {});
  const wossamotta = schoolCtx.orgRosters.find((r) => r.kind === "school");
  check(
    "the school roster counts the alum who also has an employer",
    wossamotta?.total === 2,
    JSON.stringify(schoolCtx.orgRosters.map((r) => [r.kind, r.name, r.total]))
  );
  check(
    "and its total matches the people it lists",
    wossamotta?.total === wossamotta?.people.length,
    JSON.stringify({ total: wossamotta?.total, listed: wossamotta?.people.length })
  );
  check(
    "the employer still counts them too — one contact, two organisations",
    schoolCtx.orgRosters.every((r) => r.kind !== "company") ||
      (schoolCtx.orgRosters.find((r) => r.kind === "company")?.total ?? 0) >= 1,
    JSON.stringify(schoolCtx.orgRosters.map((r) => [r.kind, r.name, r.total]))
  );

  // --- two spellings of one school are one roster --------------------------------------

  await db.insert(contacts).values([
    { userId: USER, fullName: "Acronym Alum", school: "MIT" },
    { userId: USER, fullName: "Longhand Alum", school: "Massachusetts Institute of Technology" },
  ]);
  const mitCtx = await prepareChatContext(USER, "Who do I know from MIT?", {});
  const mit = mitCtx.orgRosters.find((r) => r.kind === "school");
  check(
    "asking by the acronym finds the people listed under the long form too",
    mit?.total === 2,
    JSON.stringify(mitCtx.orgRosters.map((r) => [r.kind, r.name, r.total]))
  );
  const longCtx = await prepareChatContext(
    USER,
    "Who do I know from Massachusetts Institute of Technology?",
    {}
  );
  const long = longCtx.orgRosters.find((r) => r.kind === "school");
  check(
    "and asking by the long form finds the acronym's people",
    long?.total === 2,
    JSON.stringify(longCtx.orgRosters.map((r) => [r.kind, r.name, r.total]))
  );

  // --- attached people: the composer's `+` puts a real timeline in front of the model ---

  const marcus = (
    await db
      .insert(contacts)
      .values({
        userId: USER,
        fullName: "Marcus Webb",
        preferredName: "Marcus",
        company: "Ramp",
        title: "Head of Platform",
        relationshipScore: 4,
      })
      .returning()
  )[0].id;
  await db.insert(interactions).values([
    {
      userId: USER,
      contactId: marcus,
      interactionType: "in_person",
      rawNotes: "Coffee near Bryant Park. Talked through their on-call rota.",
      interactionDate: new Date("2026-08-15T15:00:00Z"),
    },
    {
      userId: USER,
      contactId: marcus,
      interactionType: "email",
      aiSummary: "Sent the incident-review template.",
      interactionDate: new Date("2026-05-02T09:00:00Z"),
    },
  ]);

  const attachedCtx = await prepareChatContext(USER, "what should I ask next time?", {
    contextContactIds: [marcus],
  });
  check(
    "an attached person is loaded",
    attachedCtx.attachedPeople.length === 1 && attachedCtx.attachedPeople[0]!.id === marcus,
    JSON.stringify(attachedCtx.attachedPeople.map((p) => p.id))
  );
  const attachedMarcus = attachedCtx.attachedPeople[0]!;
  check("their preferred name is used, not the full name", attachedMarcus.name === "Marcus");
  check(
    "their role comes through",
    attachedMarcus.title === "Head of Platform" && attachedMarcus.company === "Ramp"
  );
  check(
    "their timeline comes through, newest first",
    attachedMarcus.timeline.length === 2 &&
      attachedMarcus.timeline[0]!.dateIso === "2026-08-15" &&
      attachedMarcus.timeline[1]!.dateIso === "2026-05-02",
    JSON.stringify(attachedMarcus.timeline)
  );
  check(
    "the timeline uses the house vocabulary, not the raw column value",
    attachedMarcus.timeline[0]!.label === "In person",
    attachedMarcus.timeline[0]!.label
  );
  check(
    "an interaction with only raw notes still yields a line",
    attachedMarcus.timeline[0]!.line.startsWith("Coffee near Bryant Park"),
    attachedMarcus.timeline[0]!.line
  );
  check("the interaction count is the real total", attachedMarcus.totalInteractions === 2);
  check(
    "the rendered block reaches the context",
    (attachedCtx.attachedContext ?? "").includes(`[id=${marcus}]`),
    attachedCtx.attachedContext ?? "null"
  );
  check(
    "an attached person is recommendable even if retrieval never saw them",
    attachedCtx.allowedContacts.has(marcus) &&
      !attachedCtx.modelContacts.some((c) => c.id === marcus),
    JSON.stringify(attachedCtx.modelContacts.map((c) => c.id))
  );

  // Someone else's contact id must not become someone else's context.
  const foreign = await prepareChatContext(USER, "what should I ask next time?", {
    contextContactIds: ["00000000-0000-4000-8000-000000000000"],
  });
  check(
    "an id the user does not own attaches nothing",
    foreign.attachedPeople.length === 0 && foreign.attachedContext === null
  );

  const none = await prepareChatContext(USER, "who do I know at Acme?", {});
  check(
    "no attachment, no block",
    none.attachedPeople.length === 0 && none.attachedContext === null
  );

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
