/**
 * Chat routing (src/lib/decisions/chat-route.ts): Jev, then the question parser's own intent
 * flags, then the keyword rules — and the roster gate. No DB, no network: scripted deciders.
 *
 * Run: npx tsx scripts/smoke-chat-route.ts
 */
import { gateRosters, routeChatQuestion, routeFromIntent, rulesRoute } from "../src/lib/decisions/chat-route";
import { sanitizeParsedQuery } from "../src/lib/chat-retrieval";
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

const never = async () => {
  throw new Error("the parser must not be consulted when Jev answered");
};

async function main() {
  console.log("Jev routes");
  let route = await routeChatQuestion({
    decider: scripted(() => ({ said: 0.9 })),
    question: "What advice did Maria give me about pricing?",
    priorTurns: [],
    intent: never,
  });
  check("a what-was-said question the rules miss goes to research", route.engine === "jev" && route.depth.depth === "research" && route.depth.reason === "asks what was said", route);

  route = await routeChatQuestion({
    decider: scripted(() => ({ attention: 0.4 })),
    question: "Who should I ask about Kubernetes?",
    priorTurns: [],
    intent: never,
  });
  check("'Who should I ask…' — the rules' attention trigger — no longer loads the brief", !route.attention && route.depth.depth === "single");
  check("…where the rules alone would have", rulesRoute("Who should I ask about Kubernetes?", false).attention);

  route = await routeChatQuestion({
    decider: scripted(() => ({ attention: 0.95 })),
    question: "Who haven’t I talked to in a while?",
    priorTurns: [],
    intent: never,
  });
  check("a curly-apostrophe attention question (a rules miss) loads the brief", route.attention);

  route = await routeChatQuestion({
    decider: scripted(() => ({ followUp: 0.97 })),
    question: "Which of them is closest to me?",
    priorTurns: [],
    intent: never,
  });
  check("a follow-up with no earlier turns has nothing to follow up on", route.depth.depth === "single");

  route = await routeChatQuestion({
    decider: scripted(() => ({ followUp: 0.97 })),
    question: "Which of them is closest to me?",
    priorTurns: [{ role: "user", content: "Which investors do I know?" }, { role: "assistant", content: "Maria and Tomas." }],
    intent: never,
  });
  check("…and with them, it researches", route.depth.depth === "research" && route.depth.reason === "follows up on the last answer");

  const shortDecider = scripted(() => ({ said: 0.99 }));
  route = await routeChatQuestion({ decider: shortDecider, question: "Ada Park", priorTurns: [], intent: never });
  check("a bare name is a lookup without asking anyone", route.engine === "rules" && route.depth.depth === "single" && shortDecider.asked === 0);

  console.log("\nWithout Jev: the parser's flags, then the rules");
  route = await routeChatQuestion({
    decider: null,
    question: "Anyone slipping through the cracks?",
    priorTurns: [],
    intent: async () => ({ needsResearch: false, attention: true, recruiters: false }),
  });
  check("the parser's flags route it (no extra model call)", route.engine === "llm" && route.attention);

  route = await routeChatQuestion({
    decider: scripted(() => null),
    question: "Anyone slipping through the cracks?",
    priorTurns: [],
    intent: async () => ({ needsResearch: false, attention: true, recruiters: false }),
  });
  check("a Jev that gives no answer falls to the flags too", route.engine === "llm" && route.attention);

  route = await routeChatQuestion({
    decider: null,
    question: "What did Priya say about the Series A?",
    priorTurns: [],
    intent: async () => null,
  });
  check("no flags (parser failed or timed out) → today's rules", route.engine === "rules" && route.depth.depth === "research");

  check("a flagged research on a two-word query stays a lookup",
    routeFromIntent({ needsResearch: true, attention: false, recruiters: false }, "Ada Park", false).depth.depth === "single");

  console.log("\nThe parser's intent flags");
  const parsed = sanitizeParsedQuery(
    { semanticQuery: "x", filters: {}, expansionTerms: [], intent: { needs_research: true, attention: false, recruiters: true } },
    "q"
  );
  check("read when all three are booleans", parsed.intent?.needsResearch === true && parsed.intent.recruiters === true);
  check("dropped when any is missing — never half a route",
    sanitizeParsedQuery({ semanticQuery: "x", intent: { needs_research: true, attention: "yes" } }, "q").intent === undefined);

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
