/**
 * Pins the set-based rewrites of per-row write loops (recruiter drafts, the dashboard
 * follow-up generator and outreach-suggestion rebuild, and the chat thread read): same rows
 * and same fields as the loops they replaced, nothing written outside the caller's account.
 *
 * Runs the real server actions as demo mode's `demo-user`, against a throwaway PGlite, with
 * the model stubbed at `fetch`.
 *
 * Run: npx tsx scripts/smoke-batched-writes.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import {
  aiSuggestions,
  chatMessages,
  chatThreads,
  contacts,
  recruiterMessages,
  recruiters,
  reminders,
  userRecruiterLinks,
  userSettings,
} from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { ensureUserSettings } from "../src/lib/user-settings";
import { generateRecruiterDrafts, listRecruiterDrafts } from "../src/actions/recruiter-messages";
import { getChatThread } from "../src/actions/chat";
import { generateDueFollowUps, refreshOutreachSuggestions } from "../src/lib/reminders";

delete process.env.RESEND_API_KEY;
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
process.env.ORBIT_DEMO_DATA = "off";
(process.env as Record<string, string>).NODE_ENV = "development";

const USER = "demo-user";
const OTHER = "smoke-batched-other-tenant";
const REM_USER = "smoke-batched-reminders";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

/** `revalidatePath` throws outside a request, after the action's writes have landed. */
async function outsideRequest<T>(work: Promise<T>): Promise<T | undefined> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof Error && err.message.includes("static generation store")) return undefined;
    throw err;
  }
}

// ---- model stub: every prompt the model is sent, and a reply that names who it is for ----
const prompts: string[] = [];
const NAMES = ["Rita Recruiter", "Sam Recruiter", "Fail Recruiter"];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/api\.openai\.com/.test(url)) {
    const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : "");
    const text = typeof raw === "string" ? raw : "";
    prompts.push(text);
    const who = NAMES.find((n) => text.includes(n)) ?? "someone";
    const reply = who === "Fail Recruiter" ? { subject: "", body: "" } : { subject: `Subject for ${who}`, body: `Body for ${who}` };
    return Response.json({
      id: "c1", object: "chat.completion", created: 0, model: "gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(reply) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  }
  return realFetch(input, init);
}) as typeof fetch;

async function distinctCreatedAt(table: "recruiter_messages", where: SQL): Promise<number> {
  const db = await getDb();
  const rows = rowsOf<{ n: number }>(
    await db.execute(sql`SELECT count(DISTINCT created_at)::int AS n FROM ${sql.raw(table)} WHERE ${where}`)
  );
  return Number(rows[0]?.n ?? 0);
}

async function cleanup() {
  const db = await getDb();
  const users = [USER, OTHER, REM_USER];
  await db.delete(recruiterMessages).where(inArray(recruiterMessages.userId, users));
  await db.delete(userRecruiterLinks).where(inArray(userRecruiterLinks.userId, users));
  await db.delete(recruiters).where(inArray(recruiters.createdByUserId, users));
  await db.delete(reminders).where(inArray(reminders.userId, users));
  await db.delete(aiSuggestions).where(inArray(aiSuggestions.userId, users));
  await db.delete(chatThreads).where(inArray(chatThreads.userId, users));
  await db.delete(contacts).where(inArray(contacts.userId, users));
  await db.delete(userSettings).where(inArray(userSettings.userId, users));
}

run(async () => {
  await cleanup();
  const db = await getDb();
  await ensureUserSettings(USER);
  await db
    .update(userSettings)
    .set({ aiProvider: "openai", aiModel: "gpt-4o-mini", openaiApiKeyEncrypted: encrypt("fake-openai") })
    .where(eq(userSettings.userId, USER));

  // ------------------------------------------------------------------ recruiter drafts
  console.log("\ngenerateRecruiterDrafts: one multi-row insert, rows matched by recruiter");
  const recs = await db
    .insert(recruiters)
    .values(
      ["Rita Recruiter", "Sam Recruiter", "Fail Recruiter"].map((fullName) => ({
        fullName,
        nameNormalized: fullName.toLowerCase(),
        firm: "Search Co",
        createdByUserId: USER,
      }))
    )
    .returning();
  await db.insert(userRecruiterLinks).values(
    recs.map((r, i) => ({ userId: USER, recruiterId: r.id, aiSummary: `History with ${r.fullName}`, gmailThreadId: `thread-${i}` }))
  );
  await outsideRequest(generateRecruiterDrafts(recs.map((r) => r.id), "set_up_chat"));
  const recRows = await db.query.recruiterMessages.findMany({ where: eq(recruiterMessages.userId, USER) });
  check("one draft per recruiter whose model call succeeded", recRows.length === 2, String(recRows.length));
  for (const row of recRows) {
    const rec = recs.find((r) => r.id === row.recruiterId)!;
    const i = recs.indexOf(rec);
    check(
      `${rec.fullName}'s row carries ${rec.fullName}'s draft and thread`,
      row.body === `Body for ${rec.fullName}` && row.subject === `Subject for ${rec.fullName}` && row.gmailThreadId === `thread-${i}` && row.status === "draft" && row.intent === "set_up_chat",
      JSON.stringify(row)
    );
  }
  check("the failed draft wrote nothing", !recRows.some((r) => r.recruiterId === recs[2].id));
  const listed = await listRecruiterDrafts();
  check(
    "created_at is distinct per row, so the list order is stable",
    (await distinctCreatedAt("recruiter_messages", sql`user_id = ${USER}`)) === recRows.length && listed.length === recRows.length
  );

  // ------------------------------------------------------------------ chat thread read
  console.log("\ngetChatThread: parallel reads, ownership unchanged");
  const [mine] = await db.insert(chatThreads).values({ userId: USER, title: "Mine" }).returning();
  const [theirs] = await db.insert(chatThreads).values({ userId: OTHER, title: "Theirs" }).returning();
  await db.insert(chatMessages).values([
    { threadId: mine.id, userId: USER, role: "user", content: "hello" },
    { threadId: theirs.id, userId: OTHER, role: "user", content: "secret" },
  ]);
  const own = await getChatThread(mine.id);
  check("my own thread loads with its messages", own.thread.id === mine.id && own.messages.length === 1 && own.messages[0].content === "hello");
  const foreign = await getChatThread(theirs.id).then(
    () => "returned",
    (err: unknown) => (err instanceof Error ? err.message : String(err))
  );
  check("someone else's thread throws exactly as before", foreign === "Chat not found", foreign);
  const missing = await getChatThread("00000000-0000-4000-8000-00000000abcd").then(
    () => "returned",
    (err: unknown) => (err instanceof Error ? err.message : String(err))
  );
  check("a missing thread throws exactly as before", missing === "Chat not found", missing);

  // ------------------------------------------------------------------ dashboard follow-ups
  console.log("\nreminders.generateDueFollowUps: existing reminders retitled in one UPDATE");
  const [c1, c2, c3] = await db
    .insert(contacts)
    .values([
      { userId: REM_USER, fullName: "Carla One", preferredName: "Carla", priorityLevel: 3 },
      { userId: REM_USER, fullName: "Dev Two", priorityLevel: 3 },
      { userId: REM_USER, fullName: "Hank Hand", preferredName: "Hank", priorityLevel: 3 },
    ])
    .returning();
  const [otherContact] = await db.insert(contacts).values({ userId: OTHER, fullName: "Not Yours", priorityLevel: 3 }).returning();
  // `createdBy: "system"` — the rows this batched UPDATE is allowed to touch. It used to be
  // seeded `"user"`, which made this check assert the data loss `reminders.ts`'s guard
  // exists to prevent: a hand-written title rewritten and relabelled `system`. The batching
  // is what is under test here; who may be retitled is pinned below and in
  // `smoke-no-silent-data-loss.ts`.
  const [existingRem] = await db
    .insert(reminders)
    .values({ userId: REM_USER, contactId: c1.id, title: "old title", reminderType: "manual", createdBy: "system", status: "pending" })
    .returning();
  const [handWritten] = await db
    .insert(reminders)
    .values({
      userId: REM_USER,
      contactId: c3.id,
      title: "Send Hank the intro deck",
      reminderType: "manual",
      createdBy: "user",
      status: "pending",
    })
    .returning();
  const [foreignRem] = await db
    .insert(reminders)
    .values({ userId: OTHER, contactId: otherContact.id, title: "foreign", reminderType: "manual", createdBy: "user", status: "pending" })
    .returning();
  const before = Date.now();
  await generateDueFollowUps(REM_USER);
  const remRows = await db.query.reminders.findMany({ where: eq(reminders.userId, REM_USER), orderBy: [asc(reminders.createdAt)] });
  const retitled = remRows.find((r) => r.id === existingRem.id);
  check(
    "the existing reminder is updated in place",
    retitled?.title === "Follow up with Carla" &&
      retitled.reminderType === "generated" &&
      retitled.actionKind === "follow_up" &&
      retitled.createdBy === "system" &&
      (retitled.dueDate?.getTime() ?? 0) >= before - 1000,
    JSON.stringify(retitled)
  );
  check("no second reminder for that contact", remRows.filter((r) => r.contactId === c1.id).length === 1);
  check("the other contact gets a new one", remRows.some((r) => r.contactId === c2.id && r.title === "Follow up with Dev Two"));
  // The batched UPDATE sets title, due date, type, kind AND created_by on every row it
  // touches, so a user-authored row swept into it loses the evidence it was ever written by
  // a person. Skipped, not rewritten — and skipped without the loop then inserting a second
  // reminder for the same contact behind it.
  const handAfter = remRows.find((r) => r.id === handWritten.id);
  check(
    "a hand-written reminder is left exactly as the person wrote it",
    handAfter?.title === "Send Hank the intro deck" &&
      handAfter.createdBy === "user" &&
      handAfter.reminderType === "manual" &&
      handAfter.dueDate === null,
    JSON.stringify(handAfter)
  );
  check(
    "and skipping it does not leave a duplicate behind",
    remRows.filter((r) => r.contactId === c3.id).length === 1
  );
  const foreignAfter = await db.query.reminders.findFirst({ where: eq(reminders.id, foreignRem.id) });
  check("another account's reminder is untouched", foreignAfter?.title === "foreign" && foreignAfter.reminderType === "manual");

  // ------------------------------------------------------------------ outreach suggestions
  console.log("\nrefreshOutreachSuggestions: reads together, delete + insert atomically");
  const longAgo = new Date(Date.now() - 90 * 86_400_000);
  const [dormant] = await db
    .insert(contacts)
    .values({ userId: REM_USER, fullName: "Dora Dormant", priorityLevel: 3, lastInteractionAt: longAgo })
    .returning();
  await db.insert(aiSuggestions).values([
    { userId: REM_USER, suggestionType: "dormant_high_value", title: "stale", status: "pending" },
    { userId: REM_USER, suggestionType: "job_posting_signal", title: "job signal", status: "pending" },
  ]);
  await refreshOutreachSuggestions(REM_USER);
  await refreshOutreachSuggestions(REM_USER);
  const sugg = await db.query.aiSuggestions.findMany({ where: eq(aiSuggestions.userId, REM_USER) });
  check("the stale auto suggestion was cleared", !sugg.some((s) => s.title === "stale"));
  check("a job signal is never cleared", sugg.some((s) => s.title === "job signal"));
  const dormantRows = sugg.filter(
    (s) => s.suggestionType === "dormant_high_value" && (s.relatedContactIds ?? []).includes(dormant.id)
  );
  check("the dormant contact has exactly one fresh suggestion after two refreshes", dormantRows.length === 1, JSON.stringify(sugg));

  await cleanup();
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall batched-write checks passed");
});

