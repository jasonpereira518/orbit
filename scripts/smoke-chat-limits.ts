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
    /versionAssistantId\s*\?\s*versionOfRaw\?\.question\s*:\s*body\?\.question/.test(route)
  );
  const firstDiscard = Math.min(...["discardCountAfter(db", "truncateAfter(db", "resolveVersionTarget(db"].map((s) => route.indexOf(s)));
  check("it runs before any version work can discard later turns", tooLong >= 0 && tooLong < firstDiscard, `check@${tooLong} version@${firstDiscard}`);
  check(
    "both paths take their question from the checked text",
    /question\s*=\s*typedQuestion\s*\|\|\s*versionTarget\.priorUserRow\.content/.test(route) && /question\s*=\s*typedQuestion\s*;/.test(route)
  );

  console.log("The composers cap what is typed...");
  const panel = readFileSync("src/components/chat/chat-panel.tsx", "utf8");
  const bar = readFileSync("src/components/layout/floating-ask-bar.tsx", "utf8");
  const capped = (src: string) => src.match(/maxLength=\{CHAT_QUESTION_MAX_CHARS\}/g)?.length ?? 0;
  check("the chat composer and the edit-your-question box", capped(panel) === 2, String(capped(panel)));
  check("the floating ask bar", capped(bar) === 1, String(capped(bar)));

  console.log("The answer deadline...");
  check(
    "the route hands the answer a deadline measured from the request's start",
    /deadlineSignal\s*[:=]\s*AbortSignal\.timeout\(\s*answerDeadlineMs\(requestStartedAt\)\s*\)/.test(route)
  );
  check(
    "request.signal still goes through untouched, never merged with the deadline",
    /signal:\s*request\.signal\s*,/.test(route) && !/AbortSignal\.any\(/.test(route)
  );
  check("and a Stop is still read from request.signal alone", route.includes("if (request.signal.aborted) return;"));
  // The answer itself (`answerWithLookups`); `smoke-chat-answer-deadline` drives it through
  // the real SDKs.
  const loop = readFileSync("src/lib/chat-agent-loop.ts", "utf8");
  check(
    "the answer rethrows an abort the SDK swallowed (OpenAI's iterator just ends)",
    /signal\.throwIfAborted\(\)\s*;\s*split = splitter\.finish\(\)/.test(loop)
  );
  check(
    "the answer aborts on the deadline but only the person's Stop is the usage cancelSignal",
    /\[options\.signal,\s*options\.deadlineSignal\]/.test(loop) && /cancelSignal:\s*options\.signal\b/.test(loop)
  );

  // A real deadline abort, combined the way the answer combines it, with the user never pressing Stop.
  const stop = new AbortController();
  const deadline = AbortSignal.timeout(5);
  const combined = AbortSignal.any([stop.signal, deadline]);
  // (`AbortSignal.timeout`'s timer is unref'd, so a plain wait on the event would let the process exit.)
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  check("the deadline aborts the call", combined.aborted);
  check("and leaves the person's own signal alone", !stop.signal.aborted);

  // What the SDKs throw for an aborted call differs; every shape must read as a timeout.
  // The OpenAI and Anthropic SDKs' abort error: named plain `Error`, saying only this.
  const sdkAbort = () => new Error("Request was aborted.");
  const timeoutCopy = "Anthropic timed out — try again, or ask something shorter";
  for (const [label, thrown] of [
    ["the signal's own reason (TimeoutError)", combined.reason],
    ["an SDK's abort error", sdkAbort()],
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
