/**
 * The one-time origin pass: which already-read contacts are owed a look at how you met, what
 * that look reads (the opening of the thread plus the LinkedIn signals), and that claiming is
 * exclusive.
 *
 * Run: npx tsx scripts/smoke-relationship-origin-pass.ts
 */
import "./smoke/_env";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-origin";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-origin";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, noteBatches, relationshipDigests, relationshipRuns, userSettings } from "../src/db/schema";
import { advanceWatermarkOnly, applyDigestPlan } from "../src/lib/relationship-engine/apply";
import { loadMessageWindows } from "../src/lib/relationship-engine/gather";
import {
  ORIGIN_CHECKED,
  buildOriginWindow,
  claimOriginContacts,
  loadOriginWindows,
  originPendingCount,
  usersWithOriginWork,
} from "../src/lib/relationship-engine/origin-pass";
import { planDigestWrites } from "../src/lib/relationship-engine/rules";
import type { ValidatedDigest, WindowMessage } from "../src/lib/relationship-engine/types";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-origin-user";
const OTHER = "smoke-origin-other";
const T = new Date("2023-03-01T12:00:00.000Z");
const NOW = new Date();

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  for (const u of [USER, OTHER]) {
    for (const t of [relationshipDigests, relationshipRuns, noteBatches, interactions, contacts, userSettings]) await db.delete(t).where(eq(t.userId, u));
    await ensureUserSettings(u);
  }
}

function pure() {
  console.log("the window");
  const day = (n: number) => new Date(Date.UTC(2022, 8, 17 + n, 12));
  const msg = (id: string, at: Date, speaker: string, text: string): WindowMessage => ({ interactionId: id, at, direction: null, speaker, text });
  const thread = Array.from({ length: 100 }, (_, i) => msg(`m${i}`, day(i), "Maya", "x".repeat(200)));
  const invitation = msg("inv", new Date("2022-09-01T12:00:00Z"), "Me", "Hi Maya, we met at HackNC");
  const recommendation = msg("rec", new Date("2025-01-01T12:00:00Z"), "Maya", "A great teammate.");
  const w = buildOriginWindow("c", thread, [recommendation, invitation])!;
  const lines = w.text.split("\n");
  check("the window is bounded", w.text.length <= 6_000 + 2 * 1_000 + 64, String(w.text.length));
  check("it opens with the oldest signal", lines[0].startsWith("[2022-09-01 Me]"), lines[0].slice(0, 40));
  check("it ends with the newest", lines[lines.length - 1].startsWith("[2025-01-01"), lines[lines.length - 1].slice(0, 40));
  check("the opening of the thread is in, its end is not", w.messages.some((m) => m.interactionId === "m0") && !w.messages.some((m) => m.interactionId === "m99"));
  check("nothing is recorded as cut", w.truncatedBefore === null);

  const long = buildOriginWindow("c", [], [msg("r", day(0), "Maya", "y".repeat(5_000))])!;
  check("a long recommendation is clipped to 1,000 characters", long.messages[0].text.length === 1_000);
  const many = buildOriginWindow("c", [], Array.from({ length: 12 }, (_, i) => msg(`s${i}`, day(i), "Me", `note ${i}`)))!;
  check("at most 10 signals", many.messages.length === 10);
  check("nothing to read is no window", buildOriginWindow("c", [], []) === null);
}

async function main() {
  pure();
  await reset();
  const db = await getDb();

  console.log("\nwho is owed");
  const person = async (userId: string, name: string, digest: Partial<typeof relationshipDigests.$inferInsert> | null) => {
    const [c] = await db.insert(contacts).values({ userId, fullName: name, source: "linkedin", howMet: "LinkedIn connection", metContext: "online" }).returning();
    const texts = ["Great meeting you at HackNC!", "Likewise, let us keep in touch about the robotics project", "Sounds good, talk soon about the project"];
    const msgs = await db.insert(interactions).values(texts.map((rawNotes, i) => ({
      userId, contactId: c.id, interactionType: "linkedin_message", interactionDate: new Date(T.getTime() - (3 - i) * 86_400_000), source: "linkedin_messages",
      externalId: `li-msg:${name}:${i}`, rawNotes, topics: [], direction: i % 2 ? ("out" as const) : ("in" as const),
    }))).returning();
    msgs[2].interactionDate = T;
    await db.update(interactions).set({ interactionDate: T }).where(eq(interactions.id, msgs[2].id));
    if (digest) {
      await db.insert(relationshipDigests).values({
        contactId: c.id, userId, summary: "old summary", messageCount: 3, sources: ["linkedin"], watermarkAt: T, watermarkInteractionId: msgs[2].id, ...digest,
      });
    }
    return { id: c.id, msgs };
  };
  const A = await person(USER, "Maya A", {});
  await db.insert(interactions).values([
    { userId: USER, contactId: A.id, interactionType: "linkedin_message", interactionDate: new Date(T.getTime() + 86_400_000), source: "linkedin_messages", externalId: "li-msg:after", rawNotes: "AFTER THE WATERMARK can you send the deck by Friday", topics: [], direction: "in" as const },
    { userId: USER, contactId: A.id, interactionType: "reach_out", interactionDate: new Date("2022-09-01T12:00:00Z"), source: "linkedin_export", externalId: `li-export:invitation_sent:a:${A.id}`, rawNotes: "Hi Maya, loved your robotics talk", topics: [] },
  ]);
  const origin = { text: "Met at a talk", date: null, precision: null, context: null, excerpt: "x", interactionId: A.msgs[0].id, runId: randomUUID(), replaced: null };
  const B = await person(USER, "Has Origin B", { origin });
  const C = await person(USER, "Checked C", { sources: ["linkedin", ORIGIN_CHECKED] });
  const D = await person(USER, "Unread D", { watermarkAt: null, watermarkInteractionId: null });
  const E = await person(OTHER, "Other E", {});

  check("one contact is owed", (await originPendingCount(USER)) === 1);
  check("both users have work", (await usersWithOriginWork(10, null)).sort().join() === [OTHER, USER].sort().join());
  check("a scope narrows the users", (await usersWithOriginWork(10, [USER])).join() === USER);
  check("an empty scope is nobody", (await usersWithOriginWork(10, [])).length === 0);

  const windows = await loadOriginWindows(USER, [A.id]);
  const text = windows.get(A.id)?.text ?? "";
  check("the window has the opening and the invitation", text.includes("HackNC") && text.includes("loved your robotics talk"), text);
  check("…and nothing past the watermark", !text.includes("AFTER THE WATERMARK"));

  const C1 = randomUUID();
  const claimed = await claimOriginContacts(USER, 100, C1);
  check("the owed contact is claimed", claimed.join() === A.id, claimed.join());
  check("origin set, already checked, never read and another user's are never claimed", ![B.id, C.id, D.id, E.id].some((id) => claimed.includes(id)));
  check("a second claim gets nothing", (await claimOriginContacts(USER, 100, randomUUID())).length === 0);
  const a1 = await db.query.relationshipDigests.findFirst({ where: eq(relationshipDigests.contactId, A.id) });
  check("the claim is the in-flight marker", a1?.batchJobId === C1 && (a1.batchPendingUntil?.getTime() ?? 0) > Date.now());
  check("the claim moved nothing else", a1?.watermarkAt?.getTime() === T.getTime() && a1.messageCount === 3 && a1.summary === "old summary");
  check("a claimed contact is no longer counted", (await originPendingCount(USER)) === 0);

  console.log("\na deep first pass marks the contact checked");
  const [run] = await db.insert(relationshipRuns).values({ userId: USER, status: "running" }).returning();
  const fresh = async (name: string) => {
    const p = await person(USER, name, null);
    return { ...p, window: (await loadMessageWindows(USER, [p.id], { deepRead: true })).get(p.id)! };
  };
  const validated: ValidatedDigest = { whatTheyDo: null, workingOn: null, summary: "s", topics: [], facts: [], dated: [], undated: [], closedKeys: [], jobChange: null, origin: null, relationship: null, events: [] };
  const apply = async (name: string, deepRead: boolean) => {
    const p = await fresh(name);
    const plan = planDigestWrites(validated, { contactId: p.id, contactFirstName: "X", now: NOW, closeness: null, cadenceDays: null, existingThreads: [], remindersLeftInRun: 25 });
    await applyDigestPlan({ userId: USER, runId: run.id, contactId: p.id, window: p.window, validated, plan, deepRead });
    return (await db.query.relationshipDigests.findFirst({ where: eq(relationshipDigests.contactId, p.id) }))!.sources;
  };
  check("applyDigestPlan with the deep read marks it", (await apply("Deep F", true)).includes(ORIGIN_CHECKED));
  check("…and without it does not", !(await apply("Plain G", false)).includes(ORIGIN_CHECKED));
  const H = await fresh("Trivial H");
  await advanceWatermarkOnly(USER, run.id, H.window, { deepRead: true });
  check("a trivial deep first pass marks it too", Boolean((await db.query.relationshipDigests.findFirst({ where: eq(relationshipDigests.contactId, H.id) }))?.sources.includes(ORIGIN_CHECKED)));
  check("only the one read without the deep read is owed afterwards", (await originPendingCount(USER)) === 1);
  // A later deep pass over a contact first read before the deep read must not mark it: its opening was never read for origin.
  await db.update(relationshipDigests).set({ batchJobId: null, batchPendingUntil: null }).where(eq(relationshipDigests.contactId, A.id));
  const aWindow = (await loadMessageWindows(USER, [A.id], { deepRead: true })).get(A.id)!;
  await advanceWatermarkOnly(USER, run.id, aWindow, { deepRead: true });
  check("a later pass over an old contact leaves it owed", (await originPendingCount(USER)) === 2);

  await reset();
  console.log("\nsmoke-relationship-origin-pass: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
