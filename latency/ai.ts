/**
 * AI-path latency, in-process against the mock provider: chat (time to first token and to
 * complete, with every stage's timestamp from the SSE `step` events), and capture (paste
 * notes → reviewed contacts), at one data tier.
 *
 *   node latency/mock-providers.mjs &            # delays via MOCK_* env, see that file
 *   ORBIT_PGLITE_DIR=latency/.data/tier-5000 GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:3999 \
 *     GEMINI_API_KEY=mock npx tsx latency/ai.ts --tier 5000 [--rounds 3] [--out ...]
 *
 * The chat route handler is called the way the MCP route is in scripts/dev/efficiency-bench:
 * a `Request` straight into `POST` on a demo-mode account, so there is no HTTP or proxy in
 * the number — the result is the server's own time from "request arrived" to each event.
 * Model calls are the mock's fixed delays, so what remains is Orbit's orchestration: how
 * many calls run in series, and the database work between them. The mock logs every call
 * (provider, kind, ms); the count per question is the number that matters.
 *
 * Capture is driven through the job runner directly (create → queue → runCaptureJobById),
 * which is what the `after()` in `queueCaptureJob` does; the client's 1.5 s poll is not
 * included, so add ~750 ms mean detection lag to the "reviewed" number for what a person sees.
 */
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../src/db";
import { startQueryCount, stopQueryCount } from "../src/lib/query-counter";

const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "development";
env.ORBIT_DEMO_DATA = "off";
env.ORBIT_JEV ||= "off";
env.ORBIT_AI_RESULT_CACHE ||= "off";
env.GEMINI_API_KEY ||= "mock";
if (!env.ORBIT_PGLITE_DIR) throw new Error("ORBIT_PGLITE_DIR is required");
if (!env.GOOGLE_GEMINI_BASE_URL) throw new Error("GOOGLE_GEMINI_BASE_URL must point at latency/mock-providers.mjs");

const USER = "demo-user";
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const TIER = flag("tier", "?");
const ROUNDS = Number(flag("rounds", "3"));
const OUT = flag("out", `latency/results/ai-${TIER}.json`);
/** `--only chat` or `--only capture` runs one half. */
const ONLY = flag("only", "");

const QUESTIONS = [
  { kind: "lookup", q: "Who do I know at Acme?" },
  { kind: "open", q: "Who should I talk to about hiring a staff engineer in Toronto?" },
  { kind: "person", q: "What did I last discuss with Sarah Chen?" },
];

const NOTES = `Coffee with Priya Natarajan and Marcus Webb at the summit. Priya runs platform at Northwind and is hiring two staff engineers in Q1; she offered an intro to their CTO Dana Whitfield. Marcus is leaving Globex to start something in fintech, wants feedback on the deck next week. Also met Elena Rossi (recruiter at Initech) and Tom Okafor who knows the Waterloo alumni network. Follow up with Priya by Friday, send Marcus the deck Tuesday, and ask Elena about the design lead role.`;

const median = (xs: number[]) => { const s = [...xs].filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const r0 = (x: number | null) => (x == null ? null : Math.round(x));

async function chatOnce(question: string) {
  const { POST } = await import("../src/app/api/chat/route");
  const started = performance.now();
  startQueryCount();
  const res = await POST(new Request("https://orbit.test/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) }));
  const headersAt = performance.now() - started;
  const marks: Record<string, number> = { headers: headersAt };
  const steps: Array<{ step: string; at: number }> = [];
  let firstAnswer: number | null = null; let doneAt: number | null = null; let answerChars = 0; let error: string | null = null;
  if (!res.body) throw new Error(`status ${res.status}: ${await res.text()}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      let ev: { type?: string; delta?: string; step?: { label?: string; id?: string; status?: string; kind?: string }; message?: string } = {};
      try { ev = JSON.parse(line.slice(5)); } catch { continue; }
      const at = performance.now() - started;
      if (ev.type === "answer") { if (firstAnswer == null) firstAnswer = at; answerChars += ev.delta?.length ?? 0; }
      else if (ev.type === "step") steps.push({ step: JSON.stringify(ev.step).slice(0, 80), at: Math.round(at) });
      else if (ev.type === "done") doneAt = at;
      else if (ev.type === "error") error = ev.message ?? "error";
      else if (ev.type && marks[ev.type] == null) marks[ev.type] = at;
    }
  }
  const statements = stopQueryCount();
  return { status: res.status, headers_ms: r0(headersAt), first_token_ms: r0(firstAnswer), complete_ms: r0(doneAt ?? performance.now() - started), answer_chars: answerChars, statements, steps, marks: Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, r0(v)])), error };
}

async function captureOnce(text: string) {
  const { createCaptureJob, queueCaptureJobRow, getCaptureJobById, markCaptureJobTranscribed } = await import("../src/lib/capture-jobs");
  const { runCaptureJobById } = await import("../src/lib/capture-job-runner");
  const started = performance.now();
  const job = await createCaptureJob(USER, { sourceKind: "messy", status: "ingesting", inputText: text, batchGroupId: null, sourceLabel: null, mentionPicks: null, sourceFileHashes: null } as never);
  await markCaptureJobTranscribed(job.id);
  await queueCaptureJobRow(USER, job.id, {});
  const queuedAt = performance.now() - started;
  startQueryCount();
  const row = await runCaptureJobById(job.id);
  const statements = stopQueryCount();
  const reviewedAt = performance.now() - started;
  const fresh = row ?? (await getCaptureJobById(job.id));
  // capture_jobs.result is a CaptureParseResult: the reviewed people are `items`.
  const people = Array.isArray((fresh as { result?: { items?: unknown[] } } | null)?.result?.items) ? (fresh as { result: { items: unknown[] } }).result.items.length : null;
  return { queued_ms: r0(queuedAt), reviewed_ms: r0(reviewedAt), status: fresh?.status ?? null, people, statements };
}

async function main() {
  const db = await getDb();
  const results: Record<string, unknown> = {};
  const health = await fetch(`${env.GOOGLE_GEMINI_BASE_URL}/health`).then((r) => r.json()).catch(() => null);
  results.mock = health;

  const chat: Record<string, unknown> = {};
  for (const { kind, q } of ONLY === "capture" ? [] : QUESTIONS) {
    const runs = [];
    for (let i = 0; i < ROUNDS; i++) {
      await db.execute(sql`DELETE FROM rate_limit_buckets`);
      try { runs.push(await chatOnce(q)); } catch (err) { runs.push({ error: String(err).slice(0, 300) }); }
      console.error(`chat[${kind}] #${i}:`, JSON.stringify({ ...runs[runs.length - 1], steps: undefined, marks: undefined }));
    }
    const ok = runs.filter((r) => !("error" in r && r.error && !("first_token_ms" in r))) as Array<ReturnType<typeof chatOnce> extends Promise<infer T> ? T : never>;
    chat[kind] = {
      question: q,
      first_token_p50: median(ok.map((r) => r.first_token_ms ?? NaN)),
      complete_p50: median(ok.map((r) => r.complete_ms ?? NaN)),
      headers_p50: median(ok.map((r) => r.headers_ms ?? NaN)),
      statements_p50: median(ok.map((r) => r.statements)),
      runs,
    };
  }
  results.chat = chat;

  const captures = [];
  for (let i = 0; i < (ONLY === "chat" ? 0 : ROUNDS); i++) {
    await db.execute(sql`DELETE FROM rate_limit_buckets`);
    try { captures.push(await captureOnce(NOTES)); } catch (err) { captures.push({ error: String(err).slice(0, 300) }); }
    console.error(`capture #${i}:`, JSON.stringify(captures[captures.length - 1]));
  }
  results.capture = { notes_chars: NOTES.length, reviewed_p50: median(captures.map((c) => ("reviewed_ms" in c ? c.reviewed_ms ?? NaN : NaN))), runs: captures };

  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ tier: TIER, at: new Date().toISOString(), ...results }, null, 2));
  console.log(`wrote ${OUT}`);
  await closeDb();
}

main().then(() => process.exit(0)).catch(async (err) => { console.error(err); await closeDb().catch(() => undefined); process.exit(1); });
