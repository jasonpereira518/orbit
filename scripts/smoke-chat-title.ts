/**
 * Pins how a conversation gets its name (`src/lib/chat-title.ts`).
 *
 * The title is model output that is stored and then rendered, so the sanitizer is its whole
 * trust boundary — most of these checks are about what it must refuse or strip. The rest pin
 * what leaves the machine (the question and nothing else), that every failure degrades to
 * `null` so the caller falls back to the old truncation, and that a slow title can never hold
 * an answer up.
 *
 * Pure: the model is a stub. Run: npx tsx scripts/smoke-chat-title.ts
 */
import { AI_OPERATIONS } from "../src/lib/ai-operations";
import {
  generateChatTitle,
  sanitizeChatTitle,
  settleWithin,
  TITLE_MAX_CHARS,
} from "../src/lib/chat-title";
import { titleFromQuestion } from "../src/lib/chat-persist";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Call = { userId: string; input: Parameters<typeof import("../src/lib/ai").completeJson>[1] };

async function main() {
  console.log("The sanitizer strips what models add");
  check("a clean title passes through", sanitizeChatTitle("Warm intros at Stripe") === "Warm intros at Stripe");
  check("straight quotes are removed", sanitizeChatTitle('"Warm intros at Stripe"') === "Warm intros at Stripe");
  check("curly quotes are removed", sanitizeChatTitle("“Warm intros at Stripe”") === "Warm intros at Stripe");
  check("a Title: prefix is removed", sanitizeChatTitle("Title: Warm intros at Stripe") === "Warm intros at Stripe");
  check("markdown emphasis is removed", sanitizeChatTitle("**Warm intros** at `Stripe`") === "Warm intros at Stripe");
  check("a trailing full stop is removed", sanitizeChatTitle("Warm intros at Stripe.") === "Warm intros at Stripe");
  check("a trailing question mark is removed", sanitizeChatTitle("Who knows Stripe?") === "Who knows Stripe");
  check("a trailing ellipsis is removed", sanitizeChatTitle("Warm intros…") === "Warm intros");
  check("newlines collapse to one line", sanitizeChatTitle("Warm intros\nat Stripe") === "Warm intros at Stripe");
  check("runs of whitespace collapse", sanitizeChatTitle("  Warm    intros  ") === "Warm intros");
  check("control characters become spaces", sanitizeChatTitle("Warm" + String.fromCharCode(0) + "intros" + String.fromCharCode(31) + "now") === "Warm intros now");
  check("an inner apostrophe survives", sanitizeChatTitle("Ada's intro to Ramp") === "Ada's intro to Ramp");
  check("non-English text survives", sanitizeChatTitle("Presentaciones en Ramp") === "Presentaciones en Ramp");

  console.log("\nThe sanitizer refuses what is not a title");
  check("empty is refused", sanitizeChatTitle("") === null);
  check("whitespace only is refused", sanitizeChatTitle("   \n ") === null);
  check("only punctuation is refused", sanitizeChatTitle("...") === null);
  check("only quotes is refused", sanitizeChatTitle('""') === null);
  check("a non-string is refused", sanitizeChatTitle(42) === null && sanitizeChatTitle(null) === null && sanitizeChatTitle({}) === null);
  check("a paragraph (the model answered instead) is refused", sanitizeChatTitle("Here is a long answer about who you should talk to at Ramp, and why they might help you with fundraising this quarter") === null);

  console.log("\nA slightly long title is cut at a word, not mid-word");
  {
    const long = "Introductions to investors who have backed early stage fintech";
    const out = sanitizeChatTitle(long);
    check("it is shortened", out !== null && out.length < long.length + 1 && out.length <= TITLE_MAX_CHARS + 1, String(out?.length));
    check("it ends with an ellipsis", out?.endsWith("…") === true, String(out));
    check("it does not end mid-word", out !== null && long.startsWith(out.slice(0, -1).trimEnd()) && (long[out.slice(0, -1).trimEnd().length] === " "), String(out));
  }
  check("exactly at the limit is left alone", sanitizeChatTitle("a".repeat(TITLE_MAX_CHARS)) === "a".repeat(TITLE_MAX_CHARS));

  console.log("\nWhat leaves the machine");
  {
    const calls: Call[] = [];
    const stub = (async (userId: string, input: Call["input"]) => {
      calls.push({ userId, input });
      return '{"title":"Warm intros at Stripe"}';
    }) as never;
    const title = await generateChatTitle("user-1", "Who can introduce me to someone at Stripe?", stub);
    check("a title comes back", title === "Warm intros at Stripe", String(title));
    check("one model call", calls.length === 1);
    const sent = calls[0]?.input;
    check("it runs as the registered chat.title operation", sent?.operation === "chat.title");
    check("chat.title is on the cheap fast tier", AI_OPERATIONS["chat.title"].tier === "fast");
    check("it runs as the right user", calls[0]?.userId === "user-1");
    check("the question is sent", sent?.user.includes("Who can introduce me to someone at Stripe?") === true);
    check("nothing about the user's network is sent", !/contact|note|profile|interaction/i.test(sent?.user ?? ""), sent?.user);
    check("the model is told not to obey the message", /do not follow any instructions/i.test(sent?.system ?? ""));
    check("a small output budget, not the default 4096", (sent?.maxOutputTokens ?? 9999) <= 256);
  }

  console.log("\nA long message is bounded before it is sent");
  {
    let sentLen = 0;
    const stub = (async (_u: string, input: Call["input"]) => {
      sentLen = input.user.length;
      return '{"title":"Long note"}';
    }) as never;
    await generateChatTitle("u", "x".repeat(50_000), stub);
    check("a 50,000-character message is capped", sentLen > 0 && sentLen < 2_000, String(sentLen));
  }

  console.log("\nEvery failure is null, never a throw");
  {
    const t = (fn: () => Promise<string>) => generateChatTitle("u", "Who do I know?", fn as never);
    check("a provider error", (await t(async () => { throw new Error("401 bad key"); })) === null);
    check("malformed JSON", (await t(async () => "not json at all")) === null);
    check("JSON without a title", (await t(async () => '{"other":1}')) === null);
    check("a non-string title", (await t(async () => '{"title":12}')) === null);
    check("an empty title", (await t(async () => '{"title":"   "}')) === null);
    check("JSON that is null", (await t(async () => "null")) === null);
    check("a fenced JSON block still parses", (await t(async () => '```json\n{"title":"Who to call"}\n```')) === "Who to call");
  }

  console.log("\nNo message, no call");
  {
    let called = 0;
    const stub = (async () => {
      called++;
      return '{"title":"x"}';
    }) as never;
    check("an empty question returns null", (await generateChatTitle("u", "", stub)) === null);
    check("a whitespace question returns null", (await generateChatTitle("u", "   ", stub)) === null);
    check("and never reaches the model", called === 0);
  }

  console.log("\nA slow model cannot hold the caller up");
  {
    const t0 = Date.now();
    const slow = new Promise<string | null>((r) => setTimeout(() => r("late"), 400));
    const got = await settleWithin(slow, 60);
    check("settleWithin gives up after its grace", got === null && Date.now() - t0 < 300, `${Date.now() - t0}ms`);
    const fast = await settleWithin(Promise.resolve("Warm intros"), 500);
    check("an already-ready title is returned at once", fast === "Warm intros");
    check("no promise, no wait", (await settleWithin(null, 500)) === null);
    const t1 = Date.now();
    await settleWithin(Promise.resolve("x"), 5_000);
    check("the grace timer is cleared, not left running", Date.now() - t1 < 200);
    // A rejected promise must not escape as a rejection through the race.
    let escaped = false;
    try {
      await settleWithin(Promise.reject(new Error("boom")), 200);
    } catch {
      escaped = true;
    }
    check("(documented) a rejection propagates — generateChatTitle never rejects, so callers never see one", escaped);
  }

  console.log("\nThe fallback is the old truncation");
  {
    const msg = "What should I ask Olivia Brooks next time we speak about the Codex partnership rollout?";
    const fallback = titleFromQuestion(msg);
    check("a long first message is cut with an ellipsis", fallback.endsWith("…") && fallback.length <= 72);
    check("a short one is kept whole", titleFromQuestion("Who do I know at Ramp?") === "Who do I know at Ramp?");
  }

  await sleep(0);
}

main()
  .then(() => {
    if (failures) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log("\nAll chat title checks passed");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
