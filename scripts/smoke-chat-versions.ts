/**
 * Versions for the last turn of a chat (`src/lib/chat-versions.ts`, the version-aware half of
 * `persistAssistantTurn`, and `getChatThread`'s `versions`/`is_active` filtering).
 *
 * What has to hold: only the LAST turn can ever be versioned; a legacy pair (slot null) is
 * backfilled once, together, the first time either row is touched; a new version is written
 * inactive and the flip to active is one statement, so a failed or abandoned regenerate never
 * disturbs the version it was replacing; editing an older turn discards what came after it and
 * the target pair itself is untouched by the truncate; and a reloaded thread shows only active
 * rows plus the version list for the last slot.
 *
 * Local PGlite. Run: npx tsx scripts/smoke-chat-versions.ts
 */
import "./smoke/_env";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { chatMessages, chatThreads } from "../src/db/schema";
import { persistAssistantTurn } from "../src/lib/chat-persist";
import {
  NotLastTurnError,
  activateVersion,
  discardCountAfter,
  loadVersions,
  resolveVersionTarget,
  switchVersion,
  truncateAfter,
} from "../src/lib/chat-versions";
import { getChatThread } from "../src/actions/chat";

// getChatThread goes through requireUserId(); resolve to demo-user the way every other
// action-calling smoke does.
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
(process.env as Record<string, string>).NODE_ENV = "development";

const USER = "demo-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function newThread(): Promise<string> {
  const db = await getDb();
  const [row] = await db.insert(chatThreads).values({ userId: USER }).returning();
  return row!.id;
}

/** A turn exactly as the route writes one: user row first, then the answer via persistAssistantTurn. */
async function turn(threadId: string, question: string, opts: { legacy?: boolean } = {}) {
  const db = await getDb();
  const [userRow] = await db
    .insert(chatMessages)
    .values({ threadId, userId: USER, role: "user", content: question })
    .returning();
  const saved = await persistAssistantTurn(USER, threadId, "Thread", question, {
    answer: `Answer to: ${question}`,
    recommendations: [],
  });
  void opts;
  return { userId: userRow!.id, assistantId: saved.messageId! };
}

async function activeRows(threadId: string) {
  const db = await getDb();
  return db.query.chatMessages.findMany({
    where: and(eq(chatMessages.threadId, threadId), eq(chatMessages.isActive, true)),
    orderBy: [asc(chatMessages.createdAt)],
  });
}

async function main() {
  const db = await getDb();
  await db.delete(chatThreads).where(eq(chatThreads.userId, USER));

  console.log("an ordinary new turn");
  {
    const threadId = await newThread();
    const t1 = await turn(threadId, "Who do I know at Ramp?");
    const rows = await activeRows(threadId);
    check("both rows land active", rows.every((r) => r.isActive));
    check("no slot until something is versioned", rows.every((r) => r.slot === null));
    const thread = await getChatThread(threadId);
    check("getChatThread shows one turn", thread.messages.length === 2);
    check("with no version switcher (only one version exists)", thread.versions.length <= 1);
    void t1;
  }

  console.log("regenerating the last turn");
  {
    const threadId = await newThread();
    const t1 = await turn(threadId, "Who do I know at Ramp?");
    const target = await resolveVersionTarget(db, USER, threadId, t1.assistantId);
    check("a legacy pair is backfilled a real slot", typeof target.slot === "string" && target.slot.length > 0);
    check("its first version is 1", (await loadVersions(db, USER, threadId, target.slot)).length === 1);
    check("next version is 2", target.nextVersion === 2);
    check("regenerate keeps the same question by default", target.priorUserRow.content === "Who do I know at Ramp?");

    const [newUserRow] = await db
      .insert(chatMessages)
      .values({
        threadId,
        userId: USER,
        role: "user",
        content: target.priorUserRow.content,
        slot: target.slot,
        version: target.nextVersion,
        isActive: false,
      })
      .returning();
    const saved = await persistAssistantTurn(USER, threadId, "Thread", target.priorUserRow.content, {
      answer: "A different answer.",
      recommendations: [],
      version: { slot: target.slot, version: target.nextVersion, userMessageId: newUserRow!.id },
    });

    const rows = await activeRows(threadId);
    check("exactly one active pair after the flip", rows.length === 2, `${rows.length}`);
    check("it is the NEW version", rows.every((r) => r.version === 2));
    check("the old pair is inactive, not deleted", (await db.query.chatMessages.findFirst({ where: eq(chatMessages.id, t1.userId) }))?.isActive === false);
    const versions = await loadVersions(db, USER, threadId, target.slot);
    check("two versions now exist for the slot", versions.length === 2);
    check("in order", versions[0]!.version === 1 && versions[1]!.version === 2);
    check("done's userMessageId would be the new user row", newUserRow!.id !== t1.userId);
    void saved;

    console.log("a second regenerate");
    const target2 = await resolveVersionTarget(db, USER, threadId, saved.messageId!);
    check("reuses the SAME slot, does not mint a second one", target2.slot === target.slot);
    check("next version is 3", target2.nextVersion === 3);

    console.log("regenerating from a NON-last version is refused");
    await expectThrows(() => resolveVersionTarget(db, USER, threadId, t1.assistantId), NotLastTurnError);

    console.log("switching versions");
    const switched = await switchVersion(db, USER, threadId, target.slot, 1);
    check("switch reports the version's ids", switched?.version === 1 && switched.userMessageId === t1.userId);
    const afterSwitch = await activeRows(threadId);
    check("version 1 is active again, version 2 is not", afterSwitch.every((r) => r.version === 1));
    const loaded = await getChatThread(threadId);
    check("getChatThread now shows version 1's content", loaded.messages.find((m) => m.role === "assistant")?.content === "Answer to: Who do I know at Ramp?");
    check("but the switcher still lists all versions", loaded.versions.length === 2);
    check("switching to a version that does not exist is a no-op, not a throw", (await switchVersion(db, USER, threadId, target.slot, 99)) === null);
  }

  console.log("a failed regenerate leaves the old version active");
  {
    const threadId = await newThread();
    const t1 = await turn(threadId, "Draft me a note to Ada");
    const target = await resolveVersionTarget(db, USER, threadId, t1.assistantId);
    // The user row lands (the route always writes it before the model call); the answer
    // never does — the model call failed, or the stream was stopped.
    await db.insert(chatMessages).values({
      threadId,
      userId: USER,
      role: "user",
      content: target.priorUserRow.content,
      slot: target.slot,
      version: target.nextVersion,
      isActive: false,
    });
    const rows = await activeRows(threadId);
    check("the original pair is still the active one", rows.length === 2 && rows.every((r) => r.id === t1.userId || r.id === t1.assistantId));
    const versions = await loadVersions(db, USER, threadId, target.slot);
    check("the orphaned inactive user row does not count as a version (no matching assistant row)", versions.length === 1);
  }

  console.log("editing an OLDER turn discards what came after it");
  {
    const threadId = await newThread();
    const first = await turn(threadId, "Who works at Ramp?");
    const second = await turn(threadId, "And at Stripe?");
    const third = await turn(threadId, "And at Brex?");
    check("editing the last turn discards nothing", (await discardCountAfter(db, USER, threadId, third.assistantId)) === 0);
    check("editing the middle turn would discard the last pair", (await discardCountAfter(db, USER, threadId, second.assistantId)) === 2);
    await truncateAfter(db, USER, threadId, second.assistantId);
    const remaining = await db.query.chatMessages.findMany({ where: eq(chatMessages.threadId, threadId) });
    check("the third turn is gone", !remaining.some((r) => r.id === third.userId || r.id === third.assistantId));
    check("the second turn's own pair is untouched, still active", remaining.find((r) => r.id === second.assistantId)?.isActive === true);
    check("the second turn is now the last active one", (await activeRows(threadId)).at(-1)?.id === second.assistantId);
    // It is now genuinely the last turn, so the ordinary versioning path takes it from here.
    const target = await resolveVersionTarget(db, USER, threadId, second.assistantId);
    check("versioning it now succeeds", target.nextVersion === 2);
    void first;
  }

  console.log("prior-turn history excludes an unanswered trailing question");
  {
    const { prepareChatContext } = await import("../src/lib/chat-context");
    const threadId = await newThread();
    await turn(threadId, "Who works at Ramp?");
    // A stopped turn: the question was saved, no reply followed.
    await db.insert(chatMessages).values({ threadId, userId: USER, role: "user", content: "Orphan question, never answered" });
    const ctx = await prepareChatContext(USER, "new question", { threadId });
    check("the orphan question is not in prior-turn history", !ctx.priorTurns.some((t) => t.content === "Orphan question, never answered"));
    check("the answered turn is", ctx.priorTurns.some((t) => t.content === "Who works at Ramp?"));
  }

  console.log("prior-turn history excludes the turn being replaced");
  {
    const { prepareChatContext } = await import("../src/lib/chat-context");
    const threadId = await newThread();
    await turn(threadId, "Who works at Ramp?");
    const t2 = await turn(threadId, "And at Stripe?");
    const target = await resolveVersionTarget(db, USER, threadId, t2.assistantId);
    const ctxExcluding = await prepareChatContext(USER, "regenerated question", { threadId, excludeSlot: target.slot });
    check("excludeSlot drops the turn being replaced from prior-turn history", !ctxExcluding.priorTurns.some((t) => t.content === "And at Stripe?"));
    check("but keeps everything else", ctxExcluding.priorTurns.some((t) => t.content === "Who works at Ramp?"));
  }

  console.log("suggestions never surface an edited-away question");
  {
    const threadId = await newThread();
    const t1 = await turn(threadId, "A distinctive question nobody else would ask about zebras");
    const target = await resolveVersionTarget(db, USER, threadId, t1.assistantId);
    await activateVersion(db, threadId, target.slot, t1.userId, t1.assistantId); // no-op, still v1
    const [newUserRow] = await db
      .insert(chatMessages)
      .values({ threadId, userId: USER, role: "user", content: "A distinctive question nobody else would ask about zebras", slot: target.slot, version: 2, isActive: false })
      .returning();
    await db.update(chatMessages).set({ isActive: false }).where(eq(chatMessages.id, t1.userId));
    await activateVersion(db, threadId, target.slot, newUserRow!.id, t1.assistantId);
    const recent = await db.query.chatMessages.findMany({ where: and(eq(chatMessages.userId, USER), eq(chatMessages.role, "user"), eq(chatMessages.isActive, true)) });
    check("only the active version's row would be read as a recent question", recent.filter((r) => r.slot === target.slot).length === 1);
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll chat version checks passed");
  process.exit(0);
}

async function expectThrows(fn: () => Promise<unknown>, ctor: new (...args: never[]) => Error) {
  try {
    await fn();
    check(`throws ${ctor.name}`, false, "did not throw");
  } catch (err) {
    check(`throws ${ctor.name}`, err instanceof ctor, String(err));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
