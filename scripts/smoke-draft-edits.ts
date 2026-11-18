/**
 * Learning the changes a user keeps making to Orbit's drafts (`src/lib/draft-edits.ts`):
 * what counts as an edit, the newest-30 cap, the off switch, when a learning pass is due, what
 * a pass stores (stubbed model), and that drafts are then told the rules.
 *
 * Local PGlite, stubbed Gemini. Run: npx tsx scripts/smoke-draft-edits.ts
 */
import "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { draftEdits, userSettings } from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import {
  DRAFT_EDITS_KEPT,
  cleanLessons,
  isMeaningfulEdit,
  supportedRules,
  learnFromEdits,
  recordDraftEdit,
} from "../src/lib/draft-edits";
import { withStyleProfile } from "../src/lib/writing-instructions";
import { loadWritingInstructions } from "../src/lib/writing-instructions-store";

const USER = "smoke-draft-edits-user";
let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

let modelCalls = 0;
let lastPrompt = "";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!/generativelanguage/.test(url)) return realFetch(input, init);
  modelCalls++;
  lastPrompt = typeof init?.body === "string" ? init.body : "";
  const seen = [1, 2, 3];
  const reply = JSON.stringify({
    rules: [
      ...["Use Hey instead of Hi", "- Drop the closing <pleasantry> line", "Keep it under 80 words", "Sign with first name only", "No PS lines", "A sixth rule that is cut"].map((rule) => ({ rule, pairs: seen })),
      { rule: "Seen only twice", pairs: [1, 2] },
      { rule: "Pair numbers that do not exist", pairs: [97, 98, 99] },
      { rule: "The same pair three times", pairs: [4, 4, 4] },
    ],
  });
  return Response.json({
    candidates: [{ content: { role: "model", parts: [{ text: reply }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  });
}) as typeof fetch;

const AI = "Hi Sam,\n\nGreat seeing you at the mixer. Would Tuesday work for coffee?\n\nThanks,\nJason Pereira";
const EDITED = "Hey Sam,\n\nGood seeing you at the mixer. Tuesday for coffee?\n\nJason";

async function main() {
  console.log("what counts as an edit");
  check("identical is not an edit", !isMeaningfulEdit(AI, AI));
  check("whitespace only is not an edit", !isMeaningfulEdit(AI, AI.replace(/\n\n/g, "\n")));
  check("a one-letter typo fix is not an edit", !isMeaningfulEdit("Would Tuesday wrok?", "Would Tuesday work?"));
  check("a real rewrite is an edit", isMeaningfulEdit(AI, EDITED));
  check("an empty side is not an edit", !isMeaningfulEdit("", EDITED) && !isMeaningfulEdit(AI, "  "));

  console.log("\nthe stored rules");
  const lessons = cleanLessons(["Use Hey instead of Hi", "- Drop the closing <pleasantry> line", "Keep it under 80 words", "Sign with first name only", "No PS lines", "A sixth rule"]);
  check("at most 5, one per line, bulleted", lessons.split("\n").length === 5 && lessons.split("\n").every((l) => l.startsWith("- ")), lessons);
  check("a <placeholder> survives as {placeholder}", lessons.includes("{pleasantry}"));
  check("nothing in, nothing stored", cleanLessons([]) === "" && cleanLessons(["  ", "ok"]) === "");

  check("a rule needs 3 distinct real pairs", JSON.stringify(supportedRules([{ rule: "a", pairs: [1, 2, 3] }, { rule: "b", pairs: [1, 2] }, { rule: "c", pairs: [5, 5, 5] }, { rule: "d", pairs: [1, 2, 9] }], 4)) === JSON.stringify(["a"]));

  console.log("\njoined into what drafts are told");
  check("lessons come after notes and style", (withStyleProfile("Keep it short.", "- Opens with Hey", "- Drop the PS") ?? "").endsWith("Changes they keep making to Orbit's drafts, so make them already:\n- Drop the PS"));
  check("lessons alone", (withStyleProfile(null, null, "- Drop the PS") ?? "").startsWith("Changes they keep making"));
  check("nothing at all stays null (prompts byte-identical)", withStyleProfile(null, null, null) === null && withStyleProfile(null, "", "") === null);

  console.log("\nrecording");
  const db = await getDb();
  await db.delete(draftEdits).where(eq(draftEdits.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.insert(userSettings).values({ userId: USER, aiProvider: "gemini", aiModel: "gemini-3.5-flash", geminiApiKeyEncrypted: encrypt("fake-gemini") });
  const pair = { surface: "chat" as const, kind: "email" as const, aiText: AI, finalText: EDITED };
  check("an unedited draft is not kept", (await recordDraftEdit(USER, { ...pair, finalText: AI })) === false && (await db.select().from(draftEdits).where(eq(draftEdits.userId, USER))).length === 0);
  check("1st edit: kept, not due yet", (await recordDraftEdit(USER, pair)) === false);
  check("2nd edit: not due yet", (await recordDraftEdit(USER, pair)) === false);
  check("3rd edit: a learning pass is due", (await recordDraftEdit(USER, pair)) === true);
  for (let i = 0; i < DRAFT_EDITS_KEPT + 5; i++) await recordDraftEdit(USER, { ...pair, finalText: `${EDITED} ${i}` });
  const kept = await db.select().from(draftEdits).where(eq(draftEdits.userId, USER));
  check(`only the newest ${DRAFT_EDITS_KEPT} are kept`, kept.length === DRAFT_EDITS_KEPT, String(kept.length));
  check("and they are the newest", kept.some((r) => r.finalText.endsWith(` ${DRAFT_EDITS_KEPT + 4}`)) && !kept.some((r) => r.finalText === EDITED));

  console.log("\nlearning");
  const learned = await learnFromEdits(USER);
  check("one model call", modelCalls === 1);
  check("the model sees drafts and sends, fenced", /DRAFT/.test(lastPrompt) && /SENT/.test(lastPrompt));
  check("rules stored, capped at 5", (learned ?? "").split("\n").length === 5, learned ?? "null");
  check("unsupported rules dropped", !/Seen only twice|do not exist|same pair/.test(learned ?? ""));
  const after = await db.select().from(draftEdits).where(eq(draftEdits.userId, USER));
  check("every pair read is marked learned", after.every((r) => r.learnedAt instanceof Date));
  check("the next edit is not due on its own", (await recordDraftEdit(USER, { ...pair, finalText: `${EDITED} new` })) === false);
  check("drafts are told the rules", ((await loadWritingInstructions(USER)) ?? "").includes("- Use Hey instead of Hi"));

  console.log("\nturned off");
  await db.update(userSettings).set({ writingEditLessons: "" }).where(eq(userSettings.userId, USER));
  const before = (await db.select().from(draftEdits).where(eq(draftEdits.userId, USER))).length;
  check("nothing more is recorded", (await recordDraftEdit(USER, { ...pair, finalText: `${EDITED} off` })) === false && (await db.select().from(draftEdits).where(eq(draftEdits.userId, USER))).length === before);
  check("no learning pass runs", (await learnFromEdits(USER)) === null && modelCalls === 1);
  check("drafts are told nothing from edits", !((await loadWritingInstructions(USER)) ?? "").includes("Changes they keep making"));

  await db.delete(draftEdits).where(eq(draftEdits.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll draft edit checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
