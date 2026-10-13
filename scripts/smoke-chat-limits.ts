/**
 * The two limits on a chat request (src/lib/chat-question.ts, src/app/api/chat/route.ts):
 *
 *  - a question is capped at CHAT_QUESTION_MAX_CHARS, refused with a 400 in house voice, and
 *    the cap is checked BEFORE the edit path's version work (which can discard later turns);
 *  - the answer stream is cut by a deadline inside the route's `maxDuration`, kept apart from
 *    `request.signal` (a Stop), and a deadline abort reads as the timeout copy, not "cancelled".
 *
 * Pure: no network, no database. Run: npx tsx scripts/smoke-chat-limits.ts
 */
import { readFileSync } from "node:fs";
import {
  CHAT_QUESTION_MAX_CHARS,
  CHAT_QUESTION_TOO_LONG_MESSAGE,
  isChatQuestionTooLong,
} from "../src/lib/chat-question";
import { asAiProviderError, classifyAiError, friendlyError } from "../src/lib/errors";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function main() {
  console.log("The question cap...");
  check("it is 4,000", CHAT_QUESTION_MAX_CHARS === 4000);
  check("exactly the cap is allowed", !isChatQuestionTooLong("x".repeat(CHAT_QUESTION_MAX_CHARS)));
  check("one over is refused", isChatQuestionTooLong("x".repeat(CHAT_QUESTION_MAX_CHARS + 1)));
  check("an empty question is not 'too long' (the route has its own message)", !isChatQuestionTooLong(""));
  check(
    "the copy names the limit, in house voice",
    CHAT_QUESTION_TOO_LONG_MESSAGE.includes("4,000") && /^That question is too long — /.test(CHAT_QUESTION_TOO_LONG_MESSAGE) && !/\.$/.test(CHAT_QUESTION_TOO_LONG_MESSAGE),
    CHAT_QUESTION_TOO_LONG_MESSAGE
  );

  console.log("The route refuses an over-long question...");
  const route = readFileSync("src/app/api/chat/route.ts", "utf8");
  const tooLong = route.indexOf("isChatQuestionTooLong(typedQuestion)");
  const refusal = route.indexOf("CHAT_QUESTION_TOO_LONG_MESSAGE }, { status: 400 }");
  check("a 400 with the shared copy", tooLong >= 0 && refusal > tooLong, `check@${tooLong} refusal@${refusal}`);
  check(
    "the typed text is read from the edit's question on the edit path, the body's otherwise",
    route.includes("versionAssistantId ? versionOfRaw?.question : body?.question")
  );
  const firstDiscard = Math.min(...["discardCountAfter(db", "truncateAfter(db", "resolveVersionTarget(db"].map((s) => route.indexOf(s)));
  check("it runs before any version work can discard later turns", tooLong >= 0 && tooLong < firstDiscard, `check@${tooLong} version@${firstDiscard}`);
  check(
    "both paths take their question from the checked text",
    route.includes("question = typedQuestion || versionTarget.priorUserRow.content;") && route.includes("question = typedQuestion;")
  );

  console.log("The composers cap what is typed...");
  const panel = readFileSync("src/components/chat/chat-panel.tsx", "utf8");
  const bar = readFileSync("src/components/layout/floating-ask-bar.tsx", "utf8");
  const cap = "maxLength={CHAT_QUESTION_MAX_CHARS}";
  check("the chat composer", panel.includes(`rows={1}\n                  ${cap}`));
  check("the edit-your-question box", panel.includes(`${cap}\n            aria-label="Edit your question"`));
  check("the floating ask bar", bar.includes(`${cap}\n            autoComplete="off"`));

  console.log("The answer deadline...");
  check(
    "the route hands the answer a deadline measured from the request's start",
    route.includes("deadlineSignal: AbortSignal.timeout(answerDeadlineMs(requestStartedAt))")
  );
  check("request.signal still goes through untouched", /signal: request\.signal,\n\s+\/\/[^\n]*\n[^\n]*\n[^\n]*\n\s+deadlineSignal/.test(route));
  check("and a Stop is still read from request.signal alone", route.includes("if (request.signal.aborted) return;"));
  const ai = readFileSync("src/lib/ai.ts", "utf8");
  check(
    "the stream aborts on the deadline but only request.signal is the usage cancelSignal",
    ai.includes("[input.signal, input.deadlineSignal]") && ai.includes("{ cancelSignal: input.signal }")
  );

  // A real deadline abort, combined the way streamText combines it, with the user never pressing Stop.
  const stop = new AbortController();
  const deadline = AbortSignal.timeout(5);
  const combined = AbortSignal.any([stop.signal, deadline]);
  // (`AbortSignal.timeout`'s timer is unref'd, so a plain wait on the event would let the process exit.)
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  check("the deadline aborts the call", combined.aborted);
  check("and leaves the person's own signal alone", !stop.signal.aborted);

  // What the SDKs throw for an aborted call differs; every shape must read as a timeout.
  class APIUserAbortError extends Error {
    constructor() {
      super("Request was aborted.");
      this.name = "APIUserAbortError";
    }
  }
  const timeoutCopy = "Anthropic timed out — try again, or ask something shorter";
  for (const [label, thrown] of [
    ["the signal's own reason (TimeoutError)", combined.reason],
    ["an SDK's abort error", new APIUserAbortError()],
  ] as const) {
    const translated = asAiProviderError(thrown, "Anthropic");
    check(`${label}: the provider copy says it timed out`, translated.message === timeoutCopy, translated.message);
    check(`${label}: it reaches the person unchanged`, friendlyError(translated, "Couldn’t get an answer — try again?") === timeoutCopy);
    check(`${label}: usage files it as a timeout`, classifyAiError(thrown) === "timeout", classifyAiError(thrown));
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
