/**
 * Chat web search: off by default, on automatically only when the question needs the public
 * web (`src/lib/chat-web-decision.ts`), and how that meets the person's explicit choice, the
 * admin pause and a provider that cannot search.
 *
 * Pure: no network, no database. Run: npx tsx scripts/smoke-chat-web-decision.ts
 */
import { readFileSync } from "node:fs";
import {
  classifyWebNeed,
  decideWebForTurn,
  parseWebChoice,
  webStep,
  type WebAvailability,
  type WebChoice,
} from "../src/lib/chat-web-decision";
import { agentRulesFor, WEB_LOOKUP_LIMIT } from "../src/lib/chat-agent-loop";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` (${detail})`}`);
  if (!ok) failures++;
}

const OK: WebAvailability = { ok: true };

const NEEDS_WEB = [
  "Search the web for Stripe's latest funding round",
  "What's the latest news about Ramp?",
  "Who is the CEO of Notion?",
  "Look up Priya Rao at Stripe online",
  "What is the Stripe stock price today?",
  "Summarize https://stripe.com/newsroom for me",
  "Google her and tell me what she does now",
  "Research Priya Rao at Stripe",
  "Find PMs at Stripe I don't know",
  "Find me new people at Figma",
  "Who are founders outside my network working on climate?",
  "What's the weather in Chicago tomorrow?",
  "Give me background on the CTO of Ramp",
  "Breaking news on OpenAI",
  "what is the market cap of Nvidia",
];

const RECORDS_ONLY = [
  "Who do I know at Stripe?",
  "What did Priya say about the Series A?",
  "Who haven't I talked to in six months?",
  "Draft an email to Priya about the intro",
  "Write a LinkedIn connection note to Sam Lee",
  "What's on my calendar this week?",
  "Remind me to follow up with Alex on Friday",
  "How many contacts do I have in fintech?",
  "Which of my contacts are overdue?",
  "Tell me about Priya Rao",
  "Who did I meet at the Austin dinner?",
  "Show my notes from the last conversation with Sam",
  "Summarize my meetings with Ramp this month",
  "Who in my network could introduce me to the CEO of Stripe?",
  "Find me the people at Google I've emailed",
  "Latest news from my contacts at Stripe",
];

// Ambiguous on purpose: each could be answered from records, and a miss costs one tap.
const AMBIGUOUS = [
  "What's new with Priya?",
  "Who is Sam Lee?",
  "What does Acme do?",
  "Is Ramp hiring?",
  "Tell me about Stripe",
  "Look up Priya",
  "How's the market for PMs?",
  "check my online calendar",
  "Anything I should know today?",
  "",
  "   ",
];

async function main() {
  console.log("Classifier: needs the web");
  for (const q of NEEDS_WEB) check(q, classifyWebNeed(q).needs, JSON.stringify(classifyWebNeed(q)));

  console.log("\nClassifier: answerable from the records");
  for (const q of RECORDS_ONLY) check(q, !classifyWebNeed(q).needs, JSON.stringify(classifyWebNeed(q)));

  console.log("\nClassifier: ambiguous defaults to NOT searching");
  for (const q of AMBIGUOUS) check(JSON.stringify(q), !classifyWebNeed(q).needs, JSON.stringify(classifyWebNeed(q)));

  console.log("\nClassifier: reasons");
  check("a link is a link", classifyWebNeed("see https://x.com/a").reason === "link");
  check("an explicit ask beats the records veto", classifyWebNeed("Search the web for my contact Priya Rao").needs);
  check("a link beats the records veto", classifyWebNeed("what do you make of my contact's site https://acme.com").needs);
  check("the records veto beats a weak signal", !classifyWebNeed("Draft a note about the latest news at Stripe").needs);
  check("news reason", classifyWebNeed("latest news about Ramp").reason === "news");
  check("market reason", classifyWebNeed("Nvidia stock price").reason === "market");
  check("outside reason", classifyWebNeed("who is the CEO of Notion").reason === "outside");

  console.log("\nThe wire");
  check("absent, junk and unknown strings are auto", [undefined, null, "", "maybe", 3, {}].every((v) => parseWebChoice(v) === "auto"));
  check("on / off", parseWebChoice("on") === "on" && parseWebChoice("off") === "off");
  check("the old booleans keep their meaning", parseWebChoice(false) === "off" && parseWebChoice(true) === "on");

  console.log("\nChoice meets question");
  const needs = "Search the web for Stripe's latest funding round";
  const records = "Who do I know at Stripe?";
  const turn = (choice: WebChoice, question: string, availability: WebAvailability = OK) =>
    decideWebForTurn({ choice, question, availability });
  check("auto + a web question: on, by auto", (() => { const t = turn("auto", needs); return t.on && t.source === "auto" && t.reason === "explicit"; })());
  check("auto + a records question: off, quietly", (() => { const t = turn("auto", records); return !t.on && t.blocked === null && webStep(t) === null; })());
  check("auto + an ambiguous question: off", !turn("auto", "What's new with Priya?").on);
  check("explicit off beats auto, even for a web question", (() => { const t = turn("off", needs); return !t.on && t.source === "user"; })());
  check("explicit off beats an explicit link", !turn("off", "https://stripe.com").on);
  check("explicit on offers the tools for any question", turn("on", records).on && turn("on", records).source === "user");
  check("explicit on says nothing in the trail", webStep(turn("on", records)) === null);
  check("the default for a chat nobody touched is the question's call", turn(parseWebChoice(undefined), records).on === false && turn(parseWebChoice(undefined), needs).on === true);

  console.log("\nGates auto cannot pass");
  const paused: WebAvailability = { ok: false, why: "paused" };
  const none: WebAvailability = { ok: false, why: "no_provider" };
  for (const [label, availability] of [["the admin pause", paused], ["no provider that searches", none]] as const) {
    const autoTurn = turn("auto", needs, availability);
    check(`auto + web question + ${label}: stays off and says why`, !autoTurn.on && autoTurn.blocked === availability.why && webStep(autoTurn)?.id === "web:blocked");
    const onTurn = turn("on", records, availability);
    check(`explicit on + ${label}: stays off and says why`, !onTurn.on && onTurn.blocked === availability.why);
    check(`auto + records question + ${label}: nothing to say`, webStep(turn("auto", records, availability)) === null);
    check(`explicit off + ${label}: nothing to say`, webStep(turn("off", needs, availability)) === null);
  }
  check("the blocked line promises the records, not a search", /answering from your records/.test(webStep(turn("auto", needs, paused))!.label));

  console.log("\nThe trail line");
  const line = webStep(turn("auto", "What's the latest news about Ramp?"))!;
  check("auto turning itself on is announced, with its reason", line.id === "web:auto" && /^Web search turned on — it asks about recent news$/.test(line.label), line.label);

  console.log("\nWhat the answer model is told");
  const rules = (web: boolean, note?: Parameters<typeof agentRulesFor>[2]) => agentRulesFor("quick", web, note);
  const names = [...WEB_LOOKUP_LIMIT.tools];
  const namesNoTool = (text: string) => names.every((t) => !text.includes(t));
  check("auto-off: no web tool named, tells the user how to turn it on", namesNoTool(rules(false, "auto-off")) && /globe/.test(rules(false, "auto-off")));
  check("paused: no web tool named, says it could not check", namesNoTool(rules(false, "paused")) && /could not check the web/.test(rules(false, "paused")));
  check("no provider: no web tool named", namesNoTool(rules(false, "no_provider")));
  check("user off still says the user switched it off", /switched web search off/.test(rules(false)));
  check("auto-on names the tools and says what to do if refused", names.every((t) => rules(true, "auto-on").includes(t)) && /refused/.test(rules(true, "auto-on")));
  check("plain on is unchanged by notes", rules(true) === agentRulesFor("quick", true));

  console.log("\nWiring (source shape)");
  const route = readFileSync("src/app/api/chat/route.ts", "utf8");
  check("the route reads the choice with parseWebChoice, not `!== false`", route.includes("parseWebChoice(body?.web)") && !/body\?\.web !== false/.test(route));
  check("the route decides per message and offers the tools only on the decision", /web: webTurn\.on/.test(route));
  check("the route emits the decision as a web step", /steps\.done\("web", webLine\)/.test(route));
  check("the availability check runs only when a search is wanted", /webWanted\s*\?\s*await chatWebAvailability/.test(route));
  const loop = readFileSync("src/lib/chat-agent-loop.ts", "utf8");
  check("the loop still filters the web tools out when web is off", /web \? offered : offered\.filter/.test(loop));
  const availability = readFileSync("src/lib/chat-web-availability.ts", "utf8");
  check("availability honours the admin pause and the managed-Gemini exclusion", availability.includes("webSearchPaused") && availability.includes("WEB_SEARCH_MANAGED_EXCLUDED"));

  console.log(failures === 0 ? "\nAll chat web decision checks passed" : `\n${failures} check(s) failed`);
  if (failures > 0) process.exit(1);
  process.exit(0);
}

void main();
