/**
 * Chat routing (src/lib/decisions/chat-route.ts): the question parser's shape and intent
 * become the route, a failed parse gets the one-pass default — and the roster gate. No DB,
 * no network: scripted deciders.
 *
 * Run: npx tsx scripts/smoke-chat-route.ts
 */
import { gateRosters, routeFromParsed } from "../src/lib/decisions/chat-route";
import { fallbackParsedQuery, sanitizeParsedQuery, type ParsedQuery } from "../src/lib/chat-retrieval";
import { parseAnswers, type Decider, type DecisionRequest, type QuestionMap } from "../src/lib/decisions/jev";
import type { OrgRoster } from "../src/lib/chat-roster";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

function scripted(answer: (req: DecisionRequest<QuestionMap>) => Record<string, number> | null): Decider & { asked: number } {
  const d = {
    asked: 0,
    async ask(req: DecisionRequest<QuestionMap>) {
      d.asked += 1;
      const probs = answer(req);
      if (!probs) return null;
      const answers = parseAnswers(req.questions, {
        answers: Object.fromEntries(Object.keys(req.questions).map((k) => [k, { noul: probs[k] ?? 0.02 }])),
      });
      return answers ? { answers, model: "scripted" } : null;
    },
  };
  return d as unknown as Decider & { asked: number };
}

function parsed(fields: Record<string, unknown>, question = "q"): ParsedQuery {
  return sanitizeParsedQuery({ semanticQuery: "x", filters: {}, expansionTerms: [], ...fields }, question);
}

const NO_INTENT = { needs_research: false, attention: false, recruiters: false };

async function main() {
  console.log("The parser routes");
  let route = routeFromParsed(parsed({ shape: "open", intent: { ...NO_INTENT, needs_research: true } }), "Who can introduce me to someone at OpenAI?");
  check("an intro goes to research", route.engine === "llm" && route.depth.depth === "research" && route.shape === "open", route);

  route = routeFromParsed(parsed({ shape: "person", person: "Priya", intent: NO_INTENT }), "What did Priya say about the Series A?");
  check("what one person said is one pass, shape person", route.depth.depth === "single" && route.shape === "person");

  route = routeFromParsed(parsed({ shape: "open", intent: { ...NO_INTENT, attention: true } }), "Anyone slipping through the cracks?");
  check("the parser's attention flag loads the brief", route.attention && !route.recruiters);

  route = routeFromParsed(parsed({ shape: "person", person: "Ada Park", intent: { ...NO_INTENT, needs_research: true } }), "Ada Park");
  check("a flagged research on a two-word query stays a lookup", route.depth.depth === "single");

  console.log("\nThe calendar is answered in one pass");
  for (const q of ["What's on my calendar tomorrow?", "what's on tomorrow", "who am I meeting this week?", "when do I next see Priya?"]) {
    const viaParse = routeFromParsed(parsed({ shape: "open", intent: { ...NO_INTENT, calendar: true } }), q);
    const noParse = routeFromParsed(null, q);
    check(
      `"${q}" → the calendar block, one pass, parsed or not`,
      viaParse.calendar && noParse.calendar && viaParse.depth.depth === "single" && noParse.depth.depth === "single",
      { viaParse, noParse }
    );
  }
  route = routeFromParsed(parsed({ shape: "open", intent: { ...NO_INTENT, calendar: true } }), "Who's coming to the board meeting?");
  check("the parser's calendar flag catches what no keyword does", route.calendar && route.depth.depth === "single", route);
  route = routeFromParsed(parsed({ shape: "open", intent: { ...NO_INTENT, availability: true } }), "Do I have any gaps Thursday?");
  check("availability implies the calendar, with free time", route.calendar && route.availability, route);
  route = routeFromParsed(null, "am I free tomorrow afternoon?");
  check("…and its keyword fallback", route.calendar && route.availability, route);
  route = routeFromParsed(parsed({ shape: "open", intent: { ...NO_INTENT, calendar: true } }), "prep me for my 3pm");
  check("preparing for a meeting still goes to research (meeting_context)", route.calendar && route.depth.depth === "research", route);
  check("…and is flagged as prep, so the meeting's people lead", route.prep === true, route);
  check(
    "a schedule question is not prep",
    routeFromParsed(parsed({ shape: "open", intent: { ...NO_INTENT, calendar: true } }), "what's on tomorrow?").prep === false
  );
  route = routeFromParsed(parsed({ shape: "fact", intent: NO_INTENT }), "Any notes about pricing from my calls?");
  check("when the parser says it is not about the calendar, a keyword does not override it", !route.calendar, route);
  route = routeFromParsed(parsed({ shape: "count", intent: NO_INTENT }), "Who did I meet last week?");
  check("a past-meetings question is not a calendar question", !route.calendar, route);

  console.log("\nThe one-pass default");
  route = routeFromParsed(null, "What did Priya say about the Series A?");
  check("no parse → one pass, shape open, default engine", route.engine === "default" && route.depth.depth === "single" && route.shape === "open", route);
  route = routeFromParsed(fallbackParsedQuery("Who's overdue for a follow-up?"), "Who's overdue for a follow-up?");
  check("the parser's fallback (no intent) still loads the brief on the free keyword check", route.engine === "default" && route.attention);
  check("…and the recruiter list on its keyword check", routeFromParsed(null, "Which recruiters do I know?").recruiters);

  console.log("\nThe parser's fields");
  const p = parsed({ intent: { needs_research: true, attention: false, recruiters: true } });
  check("intent read when all three are booleans", p.intent?.needsResearch === true && p.intent.recruiters === true);
  check("intent dropped when any is missing — never half a route",
    sanitizeParsedQuery({ semanticQuery: "x", intent: { needs_research: true, attention: "yes" } }, "q").intent === undefined);
  check("an unknown shape is open", parsed({ shape: "table" }).shape === "open");
  check("a person question with no person is open", parsed({ shape: "person" }).shape === "open");
  check("the person is kept and capped", parsed({ shape: "person", person: "x".repeat(200) }).person?.length === 80);
  check("an interacted window is kept",
    JSON.stringify(parsed({ shape: "count", time: { mode: "interacted", after: "2026-09-01", before: "2026-09-30" } }).time) ===
      JSON.stringify({ mode: "interacted", after: "2026-09-01", before: "2026-09-30" }));
  check("a window that ends before it starts is dropped",
    parsed({ time: { mode: "interacted", after: "2026-09-30", before: "2026-09-01" } }).time === undefined);
  check("an impossible day is dropped", parsed({ time: { mode: "interacted", after: "2026-02-31" } }).time === undefined);
  check("a quiet window needs its start", parsed({ time: { mode: "quiet", before: "2026-09-01" } }).time === undefined);
  check("an unknown mode is dropped", parsed({ time: { mode: "soon", after: "2026-09-01" } }).time === undefined);
  check("the fallback is shape open", fallbackParsedQuery("anything").shape === "open");
  const withCal = parsed({ intent: { ...NO_INTENT, calendar: true }, calendarWindow: { after: "2026-10-16", before: "2026-10-16" } });
  check("the calendar flag and its window are read", withCal.intent?.calendar === true && withCal.calendarWindow?.after === "2026-10-16");
  check("an intent without the calendar flag keeps its other flags",
    parsed({ intent: { needs_research: true, attention: false, recruiters: false } }).intent?.needsResearch === true);
  check("a calendar window without the flag is dropped", parsed({ intent: NO_INTENT, calendarWindow: { after: "2026-10-16" } }).calendarWindow === undefined);
  check("one day is a one-day window", parsed({ intent: { ...NO_INTENT, calendar: true }, calendarWindow: { after: "2026-10-16" } }).calendarWindow?.before === "2026-10-16");
  check("a backwards window is dropped",
    parsed({ intent: { ...NO_INTENT, calendar: true }, calendarWindow: { after: "2026-10-20", before: "2026-10-16" } }).calendarWindow === undefined);

  console.log("\nThe roster gate");
  const rosters: OrgRoster[] = [
    { kind: "company", name: "Ramp", total: 3, people: [], truncated: false },
    { kind: "company", name: "Stripe", total: 2, people: [], truncated: false },
  ];
  const gated = await gateRosters(
    scripted((req) => {
      const orgs = (req.state as { orgs: Record<string, string> }).orgs;
      return Object.fromEntries(Object.entries(orgs).map(([k, v]) => [k, v.startsWith("Stripe") ? 0.9 : 0.1]));
    }),
    "I need to ramp up — who at Stripe knows sales?",
    rosters
  );
  check("keeps the org the question is about, drops the ordinary word", gated.rosters.map((r) => r.name).join() === "Stripe" && gated.engine === "jev");
  check("without Jev the rosters stand exactly as matched", (await gateRosters(null, "q", rosters)).rosters.length === 2);
  check("a Jev that gives no answer leaves them as matched too", (await gateRosters(scripted(() => null), "q", rosters)).rosters.length === 2);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll chat routing checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
