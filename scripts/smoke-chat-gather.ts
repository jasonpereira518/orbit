/**
 * The research step end to end: real retrieval, real registry tools, real passage index —
 * only the model's choices are scripted.
 *
 * What this pins, beyond the loop's own bounds (`smoke-tool-loop`):
 *
 *  - a note written through the normal path is findable by the research step the same day,
 *    and reaches the answer's evidence block;
 *  - a person the research step found joins the recommendation allowlist — otherwise the
 *    filter drops the very recommendation the extra round was paid for;
 *  - a model asking for a WRITE tool gets "no such tool" and nothing is written. The chat
 *    surface is read-only by construction, not by the model's good behaviour;
 *  - arguments are validated before anything runs;
 *  - an account with no AI grant gets an answer from retrieval alone, not an error;
 *  - a plain lookup never enters the loop at all.
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-chat-gather.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, memoryChunks } from "../src/db/schema";
import type { ToolCall, ToolDriver, ToolStep } from "../src/lib/ai-tools";
import { prepareChatContext } from "../src/lib/chat-context";
import { gatherEvidence, maybeGather } from "../src/lib/chat-gather";
import type { ChatStep } from "../src/lib/chat-stream-protocol";
import { createStepEmitter } from "../src/lib/chat-steps";
import { logNoteInteractionForUser } from "../src/lib/contact-writes";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-chat-gather-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

let seq = 0;
function scripted(rounds: ToolStep[]): { driver: ToolDriver; sentBack: Array<Array<{ call: ToolCall; content: string }>> } {
  let i = 0;
  const sentBack: Array<Array<{ call: ToolCall; content: string }>> = [];
  return {
    sentBack,
    driver: {
      async step() {
        return rounds[i++] ?? { calls: [], text: "DONE" };
      },
      addResults(results) {
        sentBack.push(results);
      },
    },
  };
}
const call = (name: string, args: unknown): ToolCall => ({ id: `g${++seq}`, name, args });

function recorder() {
  const seen: ChatStep[] = [];
  return { seen, steps: createStepEmitter((s) => seen.push({ ...s })) };
}

async function main() {
  const db = await getDb();
  await db.delete(memoryChunks).where(eq(memoryChunks.userId, USER));
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await ensureUserSettings(USER);

  const [priya] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Priya Raman", company: "Fintech Co", title: "Founder" })
    .returning();
  // An unrelated contact, so the question's own retrieval does not simply find Priya.
  await db.insert(contacts).values({ userId: USER, fullName: "Omar Haddad", company: "Stripe" });

  // Written through the normal path — which indexes it inline — so the research step sees
  // exactly what a user's note looks like the day they write it.
  await logNoteInteractionForUser(
    USER,
    {
      contactId: priya.id,
      interactionType: "coffee",
      rawNotes: "Long catch-up. Near the end she said she is raising a Series A in the spring.",
      interactionDate: new Date("2026-03-12T10:00:00Z"),
      externalId: `smoke-gather:${Date.now()}`,
    },
    { skipRevalidate: true }
  );

  const question = "what did we discuss about the Series A?";
  const ctx = await prepareChatContext(USER, question, {});

  // --- a real lookup, a write attempt, and bad arguments, in one round -----------------------

  const { seen, steps } = recorder();
  const s = scripted([
    {
      calls: [
        call("search_notes", { query: "Series A" }),
        call("create_contact", { fullName: "Injected Person" }),
        call("get_contact", { contactId: "not-a-uuid" }),
      ],
      text: "",
    },
  ]);
  const gathered = await gatherEvidence(USER, ctx, { deadline: Date.now() + 30_000, driver: s.driver, steps });

  check(
    "the research step finds the note by its words",
    gathered.evidence?.includes("Series A") === true,
    (gathered.evidence ?? "null").slice(0, 200)
  );
  check(
    "and the person it is about joins the contacts it vouches for",
    gathered.contactIds.includes(priya.id),
    JSON.stringify(gathered.contactIds)
  );

  const writeResult = s.sentBack[0]?.find((r) => r.call.name === "create_contact")?.content ?? "";
  check("a model asking for a write tool is told it does not exist", writeResult.includes("No tool named"), writeResult);
  const injected = await db.query.contacts.findFirst({
    where: eq(contacts.fullName, "Injected Person"),
  });
  check("and nothing was written", !injected);

  const badArgs = s.sentBack[0]?.find((r) => r.call.name === "get_contact")?.content ?? "";
  check("bad arguments are rejected before anything runs, in words the model can fix", badArgs.includes("Invalid arguments"), badArgs);
  check(
    "only the lookup that worked reaches the evidence",
    !gathered.evidence?.includes("create_contact") && !gathered.evidence?.includes("get_contact"),
    gathered.evidence ?? ""
  );

  const labels = seen.filter((st) => st.kind === "gather").map((st) => st.label);
  check(
    "the step names what it is looking up, as it looks",
    labels.some((l) => l.includes("Searching your notes for") && l.includes("Series A")),
    JSON.stringify(labels)
  );
  const last = seen.filter((st) => st.kind === "gather").at(-1);
  check(
    "and finishes counting only the lookups that worked",
    last?.status === "done" && last.label === "Looked up 1 thing",
    JSON.stringify(last)
  );
  check(
    "with the person it found as a ref",
    last?.refs?.some((r) => r.id === priya.id) === true,
    JSON.stringify(last?.refs)
  );

  // --- the allowlist: a person found in research survives the recommendation filter ---------

  const ctx2 = await prepareChatContext(USER, question, {});
  const retrievedPriya = ctx2.allowedContacts.has(priya.id);
  const s2 = scripted([{ calls: [call("search_notes", { query: "Series A" })], text: "" }]);
  const routed = await maybeGather(USER, ctx2, { requestStartedAt: Date.now(), driver: s2.driver });
  check("this question is routed to research", routed.depth.depth === "research", JSON.stringify(routed.depth));
  const kept = ctx2.filterRecommendations([
    { contact_id: priya.id, recruiter_id: null, name: "Priya", reason: "r", suggested_action: "a", draft_message: null },
  ]);
  check(
    `a person the research step found is recommendable${retrievedPriya ? " (retrieval had found her too)" : ""}`,
    kept.length === 1,
    JSON.stringify(kept)
  );

  // --- the budget: too little time left means no research round at all ----------------------

  const s3 = scripted([{ calls: [call("search_notes", { query: "Series A" })], text: "" }]);
  let asked = 0;
  const counting: ToolDriver = {
    step: async (signal) => {
      asked++;
      return s3.driver.step(signal);
    },
    addResults: s3.driver.addResults,
  };
  const late = await maybeGather(USER, await prepareChatContext(USER, question, {}), {
    // 36s into a request: less than the minimum left before the 38s cut-off.
    requestStartedAt: Date.now() - 36_000,
    driver: counting,
  });
  check("with too little time left, research does not start", asked === 0 && late.evidence === null, `${asked} rounds`);

  // --- no grant: an answer from retrieval, not an error --------------------------------------

  const { seen: seen4, steps: steps4 } = recorder();
  let threw: unknown = null;
  const keyless = await maybeGather(USER, await prepareChatContext(USER, question, {}), {
    requestStartedAt: Date.now(),
    steps: steps4,
  }).catch((err) => {
    threw = err;
    return null;
  });
  check("an account with no AI grant does not throw from research", threw === null, String(threw));
  check("it gets no evidence, and answers from retrieval", keyless?.evidence === null);
  check(
    "and the step says so instead of vanishing",
    seen4.some((st) => st.kind === "gather" && st.label === "Answered from what was already found"),
    JSON.stringify(seen4.map((st) => st.label))
  );

  // --- a plain lookup never enters the loop ---------------------------------------------------

  const { seen: seen5, steps: steps5 } = recorder();
  const plain = await maybeGather(USER, await prepareChatContext(USER, "Who do I know at Stripe?", {}), {
    requestStartedAt: Date.now(),
    steps: steps5,
  });
  check("a plain lookup stays on the single pass", plain.depth.depth === "single", JSON.stringify(plain.depth));
  check("and emits no research step at all", !seen5.some((st) => st.kind === "gather"));

  await db.delete(memoryChunks).where(eq(memoryChunks.userId, USER));
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll chat-gather checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
