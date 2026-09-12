/**
 * The meeting upload queue with `fetch` stubbed: chunks go up one at a time in seq order,
 * Stop's drain waits for the chunk enqueued in the same breath, a transient failure is
 * retried, a bad chunk is dropped, and the responses that mean "stop" stop it. Under node
 * there is no IndexedDB, so this also covers the in-memory fallback.
 * Run: npx tsx scripts/smoke-meeting-upload-queue.ts
 */
import { MeetingUploadQueue, type OutboxChunk, type QueueFatal } from "../src/lib/meeting-upload-queue";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

/** Install a fetch that answers from `script` per seq, recording every request. */
function stubFetch(script: (seq: number, attempt: number) => Reply) {
  const requests: { url: string; seq: number; silent: boolean; recorder: string | null; bytes: number }[] = [];
  const attempts = new Map<number, number>();
  let inFlight = 0;
  let maxInFlight = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const seq = Number(url.searchParams.get("seq"));
    const n = (attempts.get(seq) ?? 0) + 1;
    attempts.set(seq, n);
    const headers = new Headers(init?.headers);
    const body = init?.body as ArrayBuffer | null | undefined;
    requests.push({
      url: url.pathname,
      seq,
      silent: url.searchParams.get("silent") === "1",
      recorder: headers.get("x-orbit-recorder"),
      bytes: body ? body.byteLength : 0,
    });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    const reply = script(seq, n);
    return new Response(JSON.stringify(reply.body ?? { seq, text: `line ${seq}`, engine: "whisper", duplicate: false }), {
      status: reply.status,
      headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
    });
  }) as typeof fetch;
  return { requests, maxInFlight: () => maxInFlight };
}

function chunk(seq: number, silent = false): OutboxChunk {
  return {
    sessionId: "00000000-0000-4000-8000-000000000001",
    seq,
    startMs: seq * 60_000,
    endMs: (seq + 1) * 60_000,
    silent,
    wav: silent ? null : new Uint8Array(1000 + seq).buffer,
  };
}

function makeQueue() {
  const results: number[] = [];
  const statuses: string[] = [];
  const fatals: QueueFatal[] = [];
  const queue = new MeetingUploadQueue({
    sessionId: "00000000-0000-4000-8000-000000000001",
    recorderId: "rec-1",
    onResult: (r) => results.push(r.seq),
    onStatus: (seq, status) => statuses.push(`${seq}:${status}`),
    onFatal: (code) => fatals.push(code),
  });
  return { queue, results, statuses, fatals };
}

async function main() {
  // ── Order, one at a time, and the request shape ─────────────────────────────────────
  {
    const f = stubFetch(() => ({ status: 200 }));
    const { queue, results } = makeQueue();
    await queue.enqueue(chunk(2));
    await queue.enqueue(chunk(0));
    await queue.enqueue(chunk(1, true));
    const drained = await queue.drain(5_000);
    check("everything is sent and acknowledged", drained && results.length === 3 && queue.backlog === 0);
    check("never more than one upload at a time", f.maxInFlight() === 1);
    check("the recorder id rides every request", f.requests.every((r) => r.recorder === "rec-1"));
    check("…to the session's chunk route", f.requests.every((r) => r.url === "/api/capture/meetings/00000000-0000-4000-8000-000000000001/chunks"));
    const silent = f.requests.find((r) => r.seq === 1)!;
    check("a silent chunk is sent as a marker with no body", silent.silent && silent.bytes === 0);
    check("an audio chunk carries its WAV", f.requests.find((r) => r.seq === 2)!.bytes === 1002);
    queue.dispose();
  }

  // ── Stop's drain must include the chunk enqueued in the same breath ─────────────────
  {
    stubFetch(() => ({ status: 200 }));
    const { queue, results } = makeQueue();
    void queue.enqueue(chunk(0)); // not awaited — exactly what Stop does
    const drained = await queue.drain(5_000);
    check("drain waits for a chunk still being written", drained && results.includes(0), JSON.stringify(results));
    queue.dispose();
  }

  // ── A transient failure is retried ──────────────────────────────────────────────────
  {
    const f = stubFetch((_seq, attempt) => (attempt === 1 ? { status: 502, body: { error: "boom" } } : { status: 200 }));
    const { queue, results, statuses } = makeQueue();
    await queue.enqueue(chunk(0));
    const drained = await queue.drain(10_000);
    check("a 502 is retried until it succeeds", drained && results.join() === "0" && f.requests.length === 2);
    check("…and reported as retrying in between", statuses.includes("0:retrying"));
    queue.dispose();
  }

  // ── 429 honours Retry-After ─────────────────────────────────────────────────────────
  {
    const started = Date.now();
    stubFetch((_seq, attempt) => (attempt === 1 ? { status: 429, headers: { "retry-after": "1" } } : { status: 200 }));
    const { queue, results } = makeQueue();
    await queue.enqueue(chunk(0));
    await queue.drain(10_000);
    const waited = Date.now() - started;
    check("a 429 waits for Retry-After, then succeeds", results.join() === "0" && waited >= 950, `${waited}ms`);
    queue.dispose();
  }

  // ── A bad chunk is dropped, the rest carry on ───────────────────────────────────────
  {
    stubFetch((seq) => (seq === 0 ? { status: 413, body: { error: "too big" } } : { status: 200 }));
    const { queue, results, statuses } = makeQueue();
    await queue.enqueue(chunk(0));
    await queue.enqueue(chunk(1));
    const drained = await queue.drain(5_000);
    check("a 413 chunk is dropped rather than retried forever", statuses.includes("0:failed") && drained);
    check("…and the next chunk still goes", results.join() === "1");
    queue.dispose();
  }

  // ── Responses that mean stop ────────────────────────────────────────────────────────
  for (const [status, code] of [
    [409, "taken-over"],
    [410, "gone"],
    [422, "no-transcription-key"],
    [401, "signed-out"],
  ] as const) {
    const f = stubFetch(() => ({ status, body: { error: "no" } }));
    const { queue, fatals } = makeQueue();
    await queue.enqueue(chunk(0));
    await queue.enqueue(chunk(1));
    await queue.drain(2_000);
    check(`${status} stops the queue as "${code}"`, fatals.join() === code && f.requests.length === 1, `${fatals} after ${f.requests.length}`);
    check(`…and keeps the chunks for a later recorder`, queue.backlog === 2);
    queue.dispose();
  }

  // ── "Retry" skips the backoff wait ──────────────────────────────────────────────────
  {
    let down = true;
    stubFetch(() => (down ? { status: 503 } : { status: 200 }));
    const { queue, results } = makeQueue();
    await queue.enqueue(chunk(0));
    await queue.drain(300); // one failure; the next attempt is now seconds away
    down = false;
    const started = Date.now();
    queue.retryFailed();
    const drained = await queue.drain(10_000);
    check("retryFailed sends at once instead of waiting out the backoff", drained && results.join() === "0" && Date.now() - started < 1_000);
    queue.dispose();
  }

  console.log("\nsmoke-meeting-upload-queue: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
