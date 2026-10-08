/**
 * A chat answer that lands must only touch the thread it answered, and the history controls
 * that could pull a thread out from under a live answer must be locked while one streams.
 *
 *   - `src/lib/chat-answer-landed.ts`: header title only for the open thread; the list update
 *     always applies to the answered thread.
 *   - Source guards (no jsdom here): every history row, phone history item and delete control
 *     is `disabled={busy}`; the chat route discards an unanswered question BEFORE the
 *     client-gone early return, so a Stop does not strand it.
 *
 * Pure: no network, no database. Run: npx tsx scripts/smoke-chat-answer-landed.ts
 */
import { readFileSync } from "node:fs";
import { headerTitleAfterAnswer, threadsAfterAnswer } from "../src/lib/chat-answer-landed";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

console.log("Header title...");
check("names the open thread", headerTitleAfterAnswer("a", "a", "Intro to Maya") === "Intro to Maya");
check("leaves another thread's header alone", headerTitleAfterAnswer("a", "b", "Intro to Maya") === null);
check("leaves a cleared (deleted/new) panel alone", headerTitleAfterAnswer("a", null, "Intro to Maya") === null);
check("no title, no change", headerTitleAfterAnswer("a", "a", null) === null && headerTitleAfterAnswer("a", "a", "") === null);

console.log("History list...");
{
  const old = new Date(2026, 0, 1);
  const now = new Date(2026, 9, 8, 12);
  const prev = [
    { id: "b", title: "B", createdAt: old, updatedAt: old },
    { id: "a", title: null, createdAt: old, updatedAt: old },
  ];
  const next = threadsAfterAnswer(prev, "a", "Intro to Maya", now);
  check("answered thread moves to the top, named", next[0].id === "a" && next[0].title === "Intro to Maya", JSON.stringify(next));
  check("no duplicate row", next.filter((t) => t.id === "a").length === 1 && next.length === 2);
  check("other rows keep their order", next[1].id === "b");
  check("updatedAt is now", next[0].updatedAt === now);
  check("a thread not yet listed (deep link) is added", threadsAfterAnswer(prev, "c", "C", now).length === 3);
  check("prev is not mutated", prev[1].title === null && prev.length === 2);
}

/** The opening tag of the `<tag` element that contains `marker` (props end at a lone `>` line). */
function openingTag(src: string, marker: string, tag: string): string {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  const start = src.lastIndexOf(`<${tag}`, at);
  const end = src.slice(start).search(/\n\s*>\s*\n/);
  if (start < 0 || end < 0) throw new Error(`no <${tag}> around: ${marker}`);
  return src.slice(start, start + end);
}
const lockedWhileBusy = (src: string, marker: string, tag: string) =>
  /\bdisabled=\{busy\}/.test(openingTag(src, marker, tag));

console.log("History controls locked while an answer streams...");
{
  const rail = readFileSync("src/components/chat/chat-history-rail.tsx", "utf8");
  const panel = readFileSync("src/components/chat/chat-panel.tsx", "utf8");
  check("rail row (the active one too)", lockedWhileBusy(rail, "onSelect(thread.id)", "button"));
  check("rail delete", lockedWhileBusy(rail, "onDelete(thread.id)", "button"));
  check("phone history item", lockedWhileBusy(panel, "void loadThread(thread.id, { prefetched: true });", "DropdownMenuItem"));
  check("phone history delete", lockedWhileBusy(panel, "removeThread(thread.id);", "button"));
}

console.log("Stop does not strand the question...");
{
  const route = readFileSync("src/app/api/chat/route.ts", "utf8");
  const discard = route.indexOf("await discardUnansweredQuestion(");
  const early = route.indexOf("if (request.signal.aborted) return;");
  check("discard runs before the client-gone return", discard >= 0 && early >= 0 && discard < early, `discard@${discard} early@${early}`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed.");
process.exit(0);
