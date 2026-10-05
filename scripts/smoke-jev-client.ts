/**
 * Jev, TypeSafe's decision model — the transport, the answer parser, the decisions built on
 * it, and the one invariant that matters: a decision is always optional. No key, a timeout,
 * a 429, a malformed answer — each resolves to "no answer", and the caller's pre-Jev path
 * runs. Nothing here ever throws into a caller.
 *
 * Local PGlite for the account half (grants, usage rows, the answer cache); a stubbed fetch
 * throughout — no request leaves the machine.
 *
 * Run: npx tsx scripts/smoke-jev-client.ts
 */
import "./smoke/_env";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { aiResultCache, usageEvents, userSettings } from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { classifyAiError } from "../src/lib/errors";
import { isKeyRejection } from "../src/lib/ai-key-check";
import { systemOneRequest, TypeSafeApiError, TYPESAFE_SYSTEM_ONE_URL } from "../src/lib/typesafe-api";
import {
  askPerItem,
  noul,
  choice,
  score,
  openDecider,
  parseAnswers,
  type Decider,
  type DecisionRequest,
  type QuestionMap,
} from "../src/lib/decisions/jev";
import { RECRUITER_TUNING, RERANK_TUNING } from "../src/lib/decisions/catalog";
import { admitRecruiterCandidates, rulesOutRecruiter } from "../src/lib/decisions/recruiter";
import { RULED_OUT_VERDICT, classifyRecruiterSender } from "../src/lib/recruiter-scan";
import { rerankCandidates, rerankWithDecider, FINAL_CONTACT_COUNT } from "../src/lib/chat-retrieval";
import type { RankedContact } from "../src/lib/hybrid-search";
import { run } from "./smoke/_env";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  }
}

/* ------------------------------------------------------------------ helpers ---------- */

type Call = { url: string; key: string | null; body: Record<string, unknown> };

/** A fetch that answers from a script and records what it was sent. */
function stubFetch(respond: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const key = new Headers(init?.headers).get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
    const call = { url, key, body: JSON.parse(String(init?.body ?? "{}")) };
    calls.push(call);
    return respond(call, calls.length);
  }) as typeof fetch;
  return { impl, calls };
}

const ok = (answers: Record<string, unknown>, inputTokens = 1000) =>
  Response.json({ model: "jev-1.13.0", answers, usage: { input_tokens: inputTokens, output_tokens: 3 } });

/**
 * A decider that answers from a function of the request — how the decisions below are
 * tested without a network. Returning null plays a failed call.
 */
function scripted(
  answer: (req: DecisionRequest<QuestionMap>) => Record<string, unknown> | null
): Decider & { requests: DecisionRequest<QuestionMap>[] } {
  const requests: DecisionRequest<QuestionMap>[] = [];
  return {
    requests,
    async ask(req) {
      requests.push(req as DecisionRequest<QuestionMap>);
      const raw = answer(req as DecisionRequest<QuestionMap>);
      if (!raw) return null;
      const answers = parseAnswers(req.questions, { answers: raw });
      return answers ? { answers, model: "jev-test" } : null;
    },
  } as Decider & { requests: DecisionRequest<QuestionMap>[] };
}

const contact = (id: string, over: Partial<RankedContact> = {}): RankedContact =>
  ({
    id, fullName: `Person ${id}`, preferredName: null, company: null, school: null, title: null,
    location: null, email: null, industry: null, notes: null, aiSummary: null, keyFacts: [],
    opportunities: [], relationshipScore: 3, priorityLevel: 0, closenessTier: null, tags: [],
    rrfScore: 0, relevance: 0, matchedArms: [], filterMatched: true, ...over,
  }) as RankedContact;

/* ---------------------------------------------------------------- transport ---------- */

async function transport() {
  console.log("The transport");
  const body = { model: "jev-1.13.0", state: "hi", questions: { q: { type: "noul" as const, instructions: "?" } } };

  let stub = stubFetch(() => ok({ q: { type: "noul", noul: 0.9 } }));
  const res = await systemOneRequest("sk-test", body, { fetchImpl: stub.impl });
  check("posts to TypeSafe's systemone endpoint with the key as a bearer token",
    stub.calls[0]?.url === TYPESAFE_SYSTEM_ONE_URL && stub.calls[0]?.key === "sk-test", stub.calls[0]);
  check("…sending the model, state and questions as given", JSON.stringify(stub.calls[0]?.body) === JSON.stringify(body));
  check("…and hands back the parsed body", (res.answers as { q?: { noul?: number } })?.q?.noul === 0.9);

  stub = stubFetch((_c, n) => (n === 1 ? new Response("slow down", { status: 429 }) : ok({})));
  await systemOneRequest("k", body, { fetchImpl: stub.impl, backoffMs: 1 });
  check("a 429 is retried once", stub.calls.length === 2);

  stub = stubFetch(() => new Response("overloaded", { status: 529 }));
  let err: unknown = null;
  try {
    await systemOneRequest("k", body, { fetchImpl: stub.impl, backoffMs: 1 });
  } catch (e) {
    err = e;
  }
  check("…and a 529 that persists stops after the one retry, as a TypeSafeApiError",
    stub.calls.length === 2 && err instanceof TypeSafeApiError && err.status === 529);

  stub = stubFetch(() => new Response('{"detail":"bad key"}', { status: 401 }));
  err = null;
  try {
    await systemOneRequest("k", body, { fetchImpl: stub.impl });
  } catch (e) {
    err = e;
  }
  check("a 401 is not retried", stub.calls.length === 1);
  check("…reads as a refused key to the save-time probe", isKeyRejection(err));
  check("…and as an auth failure to the usage ledger", classifyAiError(err) === "auth", classifyAiError(err));
}

/* ------------------------------------------------------------------- parsing --------- */

function parsing() {
  console.log("\nAnswers are checked against the question that was asked");
  const qs = {
    yes: noul("?"),
    pick: choice("?", { a: "A", b: "B", other: "neither" }),
    rank: score("?", ["low", "mid", "high"]),
  };
  const good = {
    yes: { type: "noul", noul: 0.8 },
    pick: { type: "choice", choice: "b", probabilities: { a: 0.1, b: 0.9, other: 0 }, confidence: 0.85 },
    rank: { type: "score", score: 1.5, probabilities: { "0": 0.1, "1": 0.3, "2": 0.6 }, confidence: 0.4 },
  };
  const parsed = parseAnswers(qs, { answers: good });
  check("a well-formed set parses", parsed?.yes.probability === 0.8 && parsed.pick.choice === "b" && parsed.rank.score === 1.5);
  check("…with each score scaled to 0–1 for thresholds", parsed?.rank.normalized === 0.75);
  check("the AI SDK's `probability` spelling of a noul is accepted too",
    parseAnswers({ yes: noul("?") }, { answers: { yes: { type: "noul", probability: 0.3 } } })?.yes.probability === 0.3);
  check("a probability outside 0–1 is no answer", parseAnswers({ yes: noul("?") }, { answers: { yes: { noul: 1.4 } } }) === null);
  check("a choice nobody offered is no answer", parseAnswers(qs, { answers: { ...good, pick: { choice: "zebra" } } }) === null);
  check("a score past the top level is no answer", parseAnswers(qs, { answers: { ...good, rank: { score: 3 } } }) === null);
  check("one missing answer voids the set — nothing acts on a question nobody answered",
    parseAnswers(qs, { answers: { yes: good.yes, pick: good.pick } }) === null);
  check("no body at all is no answer", parseAnswers(qs, null) === null);
  let threw = false;
  try {
    score("?", ["only one"]);
  } catch {
    threw = true;
  }
  check("a score question with fewer than 2 levels is refused where it is written", threw);
}

/* ------------------------------------------------------------ one per item ---------- */

async function perItem() {
  console.log("\nOne question per item, chunked");
  const d = scripted((req) =>
    Object.fromEntries(Object.keys(req.questions).map((k) => [k, { type: "noul", noul: Number(k.slice(1)) / 100 }])),
  );
  const answers = await askPerItem(
    d,
    {
      operation: "recruiter.prefilter",
      items: ["a", "b", "c", "d", "e"],
      chunkSize: 2,
      concurrency: 2,
      state: (chunk) => ({ items: Object.fromEntries(chunk.map(({ key, item }) => [key, item])) }),
      question: (key) => noul(`about ${key}`),
    },
    { timeoutMs: 1000 },
  );
  check("five items at two a call is three calls", d.requests.length === 3, d.requests.length);
  check("each chunk files its items under c01, c02…", JSON.stringify(d.requests[0]?.state) === JSON.stringify({ items: { c01: "a", c02: "b" } }));
  check("answers come back in item order", answers.map((a) => a?.probability).join(",") === "0.01,0.02,0.01,0.02,0.01");

  const flaky = scripted((req) => (JSON.stringify(req.state).includes('"c"') ? null : { c01: { noul: 0.5 }, c02: { noul: 0.5 } }));
  const partial = await askPerItem(
    flaky,
    {
      operation: "recruiter.prefilter",
      items: ["a", "b", "c", "d"],
      chunkSize: 2,
      concurrency: 1,
      state: (chunk) => ({ items: Object.fromEntries(chunk.map(({ key, item }) => [key, item])) }),
      question: () => noul("?"),
    },
    { timeoutMs: 1000 },
  );
  check("a failed call leaves only its own items unanswered", partial.map((a) => (a ? "y" : "n")).join("") === "yynn");
}

/* ---------------------------------------------------------------- recruiters --------- */

async function recruiters() {
  console.log("\nThe recruiter prefilter wins back what the keywords miss");
  const lines = [
    { id: "m1", from: "Jo Park <jo@agency.example>", subject: "Technical Recruiter reaching out", snippet: "hi" },
    { id: "m2", from: "Sam Lee <sam@startup.example>", subject: "Your background", snippet: "I lead the platform team and we have an opening" },
    { id: "m3", from: "Sam Lee <sam@startup.example>", subject: "Following up", snippet: "any thoughts?" },
    { id: "m4", from: "News <news@digest.example>", subject: "This week in tech", snippet: "top stories" },
    { id: "m5", from: "Kim <kim@known.example>", subject: "hello", snippet: "catching up" },
  ];
  const probs: Record<string, number> = { "sam@startup.example": 0.92, "news@digest.example": 0.04 };
  const d = scripted((req) => {
    const msgs = (req.state as { messages: Record<string, { from: string }> }).messages;
    return Object.fromEntries(
      Object.entries(msgs).map(([k, m]) => [k, { noul: probs[m.from.match(/<(.+)>/)![1]] ?? 0.5 }]),
    );
  });

  const keywordsOnly = await admitRecruiterCandidates(lines, null, { alreadyCandidate: () => false });
  check("with no decider, only the keyword match is admitted — exactly as before", [...keywordsOnly].join(",") === "m1");

  const admitted = await admitRecruiterCandidates(lines, d, { alreadyCandidate: (e) => e === "kim@known.example" });
  check("the keyword match stands without a question", admitted.has("m1"));
  check("a hiring manager the keywords missed is admitted, with every line from them", admitted.has("m2") && admitted.has("m3"));
  check("a newsletter Jev reads as no stays out", !admitted.has("m4"));
  const asked = d.requests.flatMap((r) => Object.values((r.state as { messages: Record<string, { from: string }> }).messages).map((m) => m.from));
  check("each sender is asked about once, and a known candidate not at all",
    asked.length === 2 && !asked.some((f) => f.includes("kim@")) && !asked.some((f) => f.includes("jo@")), asked);

  const down = scripted(() => null);
  const fallback = await admitRecruiterCandidates(lines, down, { alreadyCandidate: () => false });
  check("when Jev gives no answer, the keyword result is what stands", [...fallback].join(",") === "m1");

  console.log("\nThe gate rules a sender out only when Jev is confident");
  const input = { senderName: "A", senderEmail: "a@x.example", firmGuess: null, messages: [{ subject: "s", snippet: "t", internalDate: null }] };
  const at = (p: number) => scripted(() => ({ recruiter: { noul: p } }));
  check(`P=${RECRUITER_TUNING.gateReject} rules out`, await rulesOutRecruiter(at(RECRUITER_TUNING.gateReject), input));
  check("P=0.5 goes to the LLM", !(await rulesOutRecruiter(at(0.5), input)));
  check("no answer goes to the LLM", !(await rulesOutRecruiter(scripted(() => null), input)));

  const verdict = await classifyRecruiterSender("u-no-db", input, { decider: at(0.02) });
  check("a ruled-out sender gets the rejection verdict without any model call (no account was even read)",
    verdict === RULED_OUT_VERDICT && !verdict.isRecruiter);
}

/* ------------------------------------------------------------------- rerank ---------- */

async function rerank() {
  console.log("\nThe chat rerank on the decision model");
  const pool = Array.from({ length: 30 }, (_, i) => contact(`c${i}`));
  // Scores by the contact's position: the last few are the best matches.
  const byName = (req: DecisionRequest<QuestionMap>) => {
    const cands = (req.state as { candidates: Record<string, { name: string }> }).candidates;
    return Object.fromEntries(
      Object.entries(cands).map(([k, c]) => {
        const i = Number(c.name.replace("Person c", ""));
        return [k, { type: "score", score: i >= 20 ? 3 : i >= 15 ? 1 : 0 }];
      }),
    );
  };
  const d = scripted(byName);
  const ranked = await rerankWithDecider(d, "who works on payments?", pool);
  check(`thirty candidates at ${RERANK_TUNING.chunkSize} a call`, d.requests.length === Math.ceil(30 / RERANK_TUNING.chunkSize));
  check(`keeps the best ${FINAL_CONTACT_COUNT}`, ranked?.length === FINAL_CONTACT_COUNT, ranked?.length);
  check("…best first", ranked?.slice(0, 10).every((c) => Number(c.id.slice(1)) >= 20) ?? false, ranked?.map((c) => c.id));
  check("…and nothing Jev called unrelated", ranked?.every((c) => Number(c.id.slice(1)) >= 15) ?? false);
  check("the card carries no id to copy back and no filter flag to weigh",
    !JSON.stringify(d.requests[0]?.state).includes('"id"') && !JSON.stringify(d.requests[0]?.state).includes("filter"));

  // c16 and c17 score alike; only c17 matched the user's explicit filters.
  const mixed = pool.map((c, i) => (i === 16 ? { ...c, filterMatched: false } : c));
  const tie = scripted((req) => {
    const cands = (req.state as { candidates: Record<string, { name: string }> }).candidates;
    return Object.fromEntries(Object.entries(cands).map(([k, c]) => [k, { score: ["Person c16", "Person c17"].includes(c.name) ? 2 : 0 }]));
  });
  const tied = await rerankWithDecider(tie, "q", mixed);
  check("on a tie, the candidate that matched the user's filters ranks first (a rule in code, not a prompt)",
    tied?.[0]?.id === "c17", tied?.slice(0, 2).map((c) => c.id));

  const partialDown = scripted((req) =>
    JSON.stringify(req.state).includes("Person c0\"") ? null : byName(req),
  );
  check("one unanswered chunk voids the Jev ranking", (await rerankWithDecider(partialDown, "q", pool)) === null);

  let llmCalls = 0;
  const llm = (async () => {
    llmCalls++;
    return JSON.stringify({ scores: pool.map((c, i) => ({ id: c.id, relevance: 10 - (i % 10) })) });
  }) as never;
  await rerankCandidates("u", "q", pool, llm, null, d);
  check("with a decider that answers, the LLM rerank never runs", llmCalls === 0);
  await rerankCandidates("u", "q", pool, llm, null, scripted(() => null));
  check("with one that does not, the LLM rerank runs as before", llmCalls === 1);
  await rerankCandidates("u", "q", pool, llm, null, null);
  check("…and with none at all", llmCalls === 2);
}

/* ------------------------------------------------------------------ accounts --------- */

const OWN = "smoke-jev-own-key";
const NONE = "smoke-jev-no-key";

async function accounts() {
  console.log("\nThe account's own key, through the gate");
  const db = await getDb();
  for (const u of [OWN, NONE]) {
    await db.delete(usageEvents).where(eq(usageEvents.userId, u));
    await db.delete(aiResultCache).where(eq(aiResultCache.userId, u));
    await db.delete(userSettings).where(eq(userSettings.userId, u));
  }
  await db.insert(userSettings).values({ userId: NONE });
  await db.insert(userSettings).values({ userId: OWN, typesafeApiKeyEncrypted: encrypt("user-typesafe-key") });

  check("no TypeSafe key: no decider — the caller's old path runs", (await openDecider(NONE)) === null);

  const stub = stubFetch((call) => {
    const keys = Object.keys(call.body.questions as object);
    return ok(Object.fromEntries(keys.map((k) => [k, { type: "noul", noul: 0.75 }])), 2000);
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub.impl;
  try {
    const decider = await openDecider(OWN);
    check("a saved key opens one", decider !== null);
    const req = { operation: "recruiter.gate" as const, state: { sender: { email: "x@y.example" } }, questions: { recruiter: noul("?") } };
    const first = await decider!.ask(req, { timeoutMs: 2000, cacheDays: 30 });
    check("the question goes out on the user's own key", stub.calls[0]?.key === "user-typesafe-key", stub.calls[0]?.key);
    check("…at the pinned model", stub.calls[0]?.body.model === "jev-1.13.0");
    check("…and comes back answered", first?.answers.recruiter.probability === 0.75);

    const again = await decider!.ask(req, { timeoutMs: 2000, cacheDays: 30 });
    check("the identical question set is answered from the cache, not asked again",
      again?.answers.recruiter.probability === 0.75 && stub.calls.length === 1, stub.calls.length);

    let row: typeof usageEvents.$inferSelect | undefined;
    for (let i = 0; i < 40 && !row; i++) {
      [row] = await db.select().from(usageEvents).where(and(eq(usageEvents.userId, OWN), eq(usageEvents.operation, "recruiter.gate")));
      if (!row) await new Promise((r) => setTimeout(r, 50));
    }
    check("one usage row: TypeSafe, a decision, on the user's key",
      row?.provider === "typesafe" && row.kind === "decision" && row.keyOwner === "user" && row.success === 1, row);
    // 2,000 input tokens at $0.042 per million is 84 micro-dollars; output is free.
    check("…priced at TypeSafe's rate", row?.estimatedCostMicros === 84, row?.estimatedCostMicros);

    process.env.ORBIT_JEV = "off";
    check("ORBIT_JEV=off: no decider, key or not", (await openDecider(OWN)) === null);
    delete process.env.ORBIT_JEV;

    // Never answers — but, like the real fetch, gives up when its signal aborts.
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      )) as typeof fetch;
    const slow = await (await openDecider(OWN))!.ask({ ...req, state: "a new state" }, { timeoutMs: 50 });
    check("a call past its timeout is no answer, not a hang or a throw", slow === null);

    globalThis.fetch = (async () => Response.json({ answers: { recruiter: { noul: "yes" } } })) as typeof fetch;
    const junk = await (await openDecider(OWN))!.ask({ ...req, state: "another state" }, { timeoutMs: 1000, cacheDays: 30 });
    check("a malformed answer is no answer", junk === null);
    const cached = await db.select().from(aiResultCache).where(eq(aiResultCache.userId, OWN));
    check("…and is never cached for the next scan to replay", cached.length === 1, cached.length);
  } finally {
    globalThis.fetch = realFetch;
    for (const u of [OWN, NONE]) {
      await db.delete(usageEvents).where(eq(usageEvents.userId, u));
      await db.delete(aiResultCache).where(eq(aiResultCache.userId, u));
      await db.delete(userSettings).where(eq(userSettings.userId, u));
    }
  }
}

run(async () => {
  await transport();
  parsing();
  await perItem();
  await recruiters();
  await rerank();
  await accounts();
  console.log(failures === 0 ? "\nAll Jev checks passed." : `\n${failures} Jev check(s) FAILED.`);
  if (failures > 0) process.exit(1);
});
