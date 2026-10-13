/**
 * An answer cut off mid-stream is a failure, not a finished answer.
 *
 * The route gives the answer stream a deadline inside `maxDuration` (see `smoke-chat-limits`).
 * OpenAI's SDK treats an abort mid-stream as "the caller stopped the stream" and just ENDS the
 * iterator — no throw — so `streamText` used to return the half-written answer: the route then
 * persisted it, sent `done`, and usage filed a success with no tokens. This drives the real
 * SDKs (OpenAI, Gemini, Anthropic) through a fake `fetch` whose SSE body hangs and then errors
 * when the request is aborted — what undici does — and pins, for each provider:
 *
 *  - a deadline abort throws the provider's timeout copy (after the prose already streamed),
 *    and usage files it as `timeout`;
 *  - the person's Stop throws too, and usage files it as `cancelled`;
 *  - a stream that finishes is untouched.
 *
 * Runs against a throwaway PGlite database; nothing leaves the process.
 * Run: npx tsx scripts/smoke-chat-answer-deadline.ts
 */
import "./smoke/_env";

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { usageEvents, userSettings } from "../src/db/schema";
import { chatWithNetworkStream } from "../src/lib/ai";
import { DEFAULT_MODELS } from "../src/lib/ai-providers";
import { encrypt } from "../src/lib/crypto";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${String(detail)}`}`);
  }
}

const enc = new TextEncoder();
const TEXT = "First words. ";
const frame = (data: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;

type Provider = "openai" | "gemini" | "anthropic";
/** What the provider has sent by the time the answer is half-written, and what finishes it. */
const FRAMES: Record<Provider, { start: string[]; finish: string[] }> = {
  openai: {
    start: [frame({ id: "c1", object: "chat.completion.chunk", created: 0, model: "stub", choices: [{ index: 0, delta: { content: TEXT }, finish_reason: null }] })],
    finish: [
      frame({ id: "c1", object: "chat.completion.chunk", created: 0, model: "stub", choices: [{ index: 0, delta: { content: "The end." }, finish_reason: "stop" }] }),
      frame({ id: "c1", object: "chat.completion.chunk", created: 0, model: "stub", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }),
      frame("[DONE]"),
    ],
  },
  gemini: {
    start: [frame({ candidates: [{ content: { role: "model", parts: [{ text: TEXT }] } }] })],
    finish: [
      frame({
        candidates: [{ content: { role: "model", parts: [{ text: "The end." }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 },
      }),
    ],
  },
  anthropic: {
    start: [
      frame({ type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "stub", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 1 } } }, "message_start"),
      frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start"),
      frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: TEXT } }, "content_block_delta"),
    ],
    finish: [
      frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The end." } }, "content_block_delta"),
      frame({ type: "content_block_stop", index: 0 }, "content_block_stop"),
      frame({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 100 } }, "message_delta"),
      frame({ type: "message_stop" }, "message_stop"),
    ],
  },
};

const providerOf = (url: string): Provider | null =>
  /streamGenerateContent/.test(url) ? "gemini" : /\/v1\/chat\/completions/.test(url) ? "openai" : /\/v1\/messages/.test(url) ? "anthropic" : null;

let script: "hang" | "finish" = "hang";
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const provider = providerOf(url);
  if (!provider) throw new Error(`unexpected request: ${url}`);
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      for (const f of FRAMES[provider].start) c.enqueue(enc.encode(f));
      if (script === "finish") {
        for (const f of FRAMES[provider].finish) c.enqueue(enc.encode(f));
        c.close();
      }
    },
  });
  // A hung body that errors with an AbortError once the request is aborted.
  if (script === "hang") {
    signal?.addEventListener("abort", () => {
      try {
        ctrl.error(new DOMException("The operation was aborted.", "AbortError"));
      } catch {
        // already closed
      }
    });
  }
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;

const KEY_COLUMN = {
  openai: "openaiApiKeyEncrypted",
  gemini: "geminiApiKeyEncrypted",
  anthropic: "anthropicApiKeyEncrypted",
} as const;
const LABEL = { openai: "OpenAI", gemini: "Gemini", anthropic: "Anthropic" } as const;

async function account(userId: string, provider: Provider) {
  const db = await getDb();
  await db.delete(userSettings).where(eq(userSettings.userId, userId));
  await db.insert(userSettings).values({
    userId,
    aiProvider: provider,
    aiModel: DEFAULT_MODELS[provider],
    [KEY_COLUMN[provider]]: encrypt(`smoke-${provider}-key`),
  });
}

async function ask(userId: string, options: { signal?: AbortSignal; deadlineSignal?: AbortSignal }) {
  const deltas: string[] = [];
  let result: unknown = null;
  let err: unknown = null;
  try {
    result = await chatWithNetworkStream(userId, "Who should I call?", [], [], [], null, [], (d) => deltas.push(d), null, null, options);
  } catch (e) {
    err = e;
  }
  return { deltas, result, err, message: err instanceof Error ? err.message : err === null ? null : String(err) };
}

/** Usage rows land fire-and-forget: poll (bounded) for the row instead of sleeping a fixed time. */
async function usageFor(userId: string) {
  const db = await getDb();
  const read = () => db.select().from(usageEvents).where(and(eq(usageEvents.userId, userId), eq(usageEvents.operation, "chat.answer")));
  let rows = await read();
  for (const start = Date.now(); rows.length === 0 && Date.now() - start < 5_000; ) {
    await new Promise((r) => setTimeout(r, 25));
    rows = await read();
  }
  return rows;
}

async function main() {
  // `AbortSignal.timeout`'s timer is unref'd and a hung fake body holds nothing open, so keep the loop alive.
  const keepAlive = setInterval(() => {}, 100);
  try {
    for (const provider of ["openai", "gemini", "anthropic"] as const) {
      console.log(`\n${LABEL[provider]}...`);

      const doneUser = `smoke-deadline-${provider}-done`;
      await account(doneUser, provider);
      // Runs first: it warms the provider SDK's lazy import, so the 300 ms deadline below times the stream, not the import.
      script = "finish";
      const whole = await ask(doneUser, { signal: new AbortController().signal, deadlineSignal: AbortSignal.timeout(30_000) });
      check("a stream that finishes inside its deadline returns the whole answer", whole.err === null && (whole.result as { answer?: string } | null)?.answer === `${TEXT}The end.`, whole.message ?? JSON.stringify(whole.result));
      const wholeRows = await usageFor(doneUser);
      check("…and usage records a success", wholeRows.length === 1 && wholeRows[0].success === 1, JSON.stringify(wholeRows.map((r) => [r.success, r.errorKind])));

      const deadlineUser = `smoke-deadline-${provider}-deadline`;
      await account(deadlineUser, provider);
      script = "hang";
      const cut = await ask(deadlineUser, { deadlineSignal: AbortSignal.timeout(300) });
      check("the prose that arrived before the deadline was streamed on", cut.deltas.join("").includes(TEXT.trim()), JSON.stringify(cut.deltas));
      check("a deadline abort throws instead of returning the half-written answer", cut.err !== null, JSON.stringify(cut.result));
      check(
        "…as the provider's timeout copy",
        cut.message === `${LABEL[provider]} timed out — try again, or ask something shorter`,
        cut.message
      );
      const cutRows = await usageFor(deadlineUser);
      check("usage records one failed call", cutRows.length === 1 && cutRows[0].success === 0, JSON.stringify(cutRows.map((r) => [r.success, r.errorKind])));
      check("…filed as a timeout", cutRows[0]?.errorKind === "timeout", cutRows[0]?.errorKind ?? "no row");

      const stopUser = `smoke-deadline-${provider}-stop`;
      await account(stopUser, provider);
      const stop = new AbortController();
      setTimeout(() => stop.abort(), 300);
      const stopped = await ask(stopUser, { signal: stop.signal });
      check("a Stop throws too, so the route takes its Stop branch", stopped.err !== null, JSON.stringify(stopped.result));
      const stopRows = await usageFor(stopUser);
      check("…and usage files it as cancelled", stopRows.length === 1 && stopRows[0].errorKind === "cancelled", JSON.stringify(stopRows.map((r) => [r.success, r.errorKind])));
    }
  } finally {
    clearInterval(keepAlive);
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
