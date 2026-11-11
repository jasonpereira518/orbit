/**
 * Pins `src/lib/chat-turn-resume.ts`: when a reopened chat thread waits for an answer the
 * server is still writing after the person left mid-turn.
 *
 * Pure: no network, no database. Run: npx tsx scripts/smoke-chat-turn-resume.ts
 */
import {
  RESUME_WINDOW_MS,
  clearTurnInFlight,
  inFlightThreadId,
  markTurnInFlight,
  pendingTurn,
} from "../src/lib/chat-turn-resume";

let failures = 0;
function check(label: string, ok: boolean) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}`);
  }
}

const now = 1_000_000_000;
const at = (msAgo: number) => new Date(now - msAgo);
const answered = [
  { role: "user", createdAt: at(30_000), clientTurnId: "t1" },
  { role: "assistant", createdAt: at(20_000), clientTurnId: null },
];

check("answered thread is not pending", !pendingTurn("a", answered, now));
check("empty thread is not pending", !pendingTurn("a", [], now));
check("a voice utterance without a reply never resumes as a text request",
  !pendingTurn("a", [{role: "user", createdAt: at(1000), clientTurnId: "voice:session"}], now));
check(
  "recent unanswered streamed question is pending",
  !!pendingTurn("a", [...answered, { role: "user", createdAt: at(5_000), clientTurnId: "t2" }], now)
);
check(
  "old unanswered question (a drop from long ago) is not pending",
  !pendingTurn("a", [...answered, { role: "user", createdAt: at(RESUME_WINDOW_MS + 1), clientTurnId: "t2" }], now)
);
check(
  "the pending turn carries the question's turn id (what Stop marks)",
  pendingTurn("a", [{ role: "user", createdAt: at(1_000), clientTurnId: "t9" }], now)?.turnId === "t9"
);
check(
  "a question with no turn id (a version turn) is not pending",
  !pendingTurn("a", [{ role: "user", createdAt: at(1_000), clientTurnId: null }], now)
);
check("ISO string timestamps (serialized rows) work", !!pendingTurn("a", [{ role: "user", createdAt: at(1_000).toISOString(), clientTurnId: "t" }], now));

markTurnInFlight("b", { startedAt: now - 3_000, turnId: "tb" });
check("in-flight send counts before its question row exists", !!pendingTurn("b", answered, now));
check("in-flight thread is the one to reopen", inFlightThreadId(now) === "b");
markTurnInFlight("c", { startedAt: now - 1_000, turnId: "tc" });
check("most recent in-flight thread wins", inFlightThreadId(now) === "c");
check("stale in-flight entry is ignored", inFlightThreadId(now + RESUME_WINDOW_MS + 10_000) === null);
clearTurnInFlight("c", "someone-else");
check("a different send cannot clear the entry", inFlightThreadId(now) === "c");
clearTurnInFlight("b", "tb");
clearTurnInFlight("c", "tc");
check("cleared send is no longer pending", !pendingTurn("b", answered, now) && inFlightThreadId(now) === null);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nchat turn resume: all checks passed");
process.exit(0);
