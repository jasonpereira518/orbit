/**
 * The PCM worklet (`public/orbit-pcm-worklet.js`) run under node with a stub worklet scope:
 * batched posting must hand the main thread exactly the samples it was given, in order, and
 * the default (no options) must still post one message per quantum.
 * Run: npx tsx scripts/smoke-pcm-worklet.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

type Processor = {
  port: { posted: Float32Array[]; onmessage: ((e: { data: unknown }) => void) | null };
  process(inputs: Float32Array[][]): boolean;
};

const source = readFileSync(join(__dirname, "..", "public", "orbit-pcm-worklet.js"), "utf8");
const make = (options?: unknown): Processor => {
  let Ctor: new (o?: unknown) => Processor = null!;
  class AudioWorkletProcessor {
    port = { posted: [] as Float32Array[], onmessage: null, postMessage(d: Float32Array) { this.posted.push(d); } };
  }
  new Function("AudioWorkletProcessor", "registerProcessor", source)(AudioWorkletProcessor, (_: string, c: typeof Ctor) => {
    Ctor = c;
  });
  return new Ctor(options);
};

// A quantum the engine reuses, as the real one does.
const quantum = new Float32Array(128);
const feed = (p: Processor, quanta: number, from = 0) => {
  for (let q = 0; q < quanta; q++) {
    for (let i = 0; i < 128; i++) quantum[i] = (from + q * 128 + i) / 1e6;
    p.process([[quantum]]);
  }
};
const flat = (parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of parts) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};
const isRamp = (xs: Float32Array, from = 0) => xs.every((v, i) => Math.abs(v - Math.fround((from + i) / 1e6)) < 1e-9);

console.log("pcm worklet");

const single = make();
feed(single, 5);
check("default posts one message per quantum", single.port.posted.length === 5 && single.port.posted.every((m) => m.length === 128));
check("default copies (no aliasing of the reused quantum)", isRamp(flat(single.port.posted)));

const batched = make({ processorOptions: { batchQuanta: 12 } });
feed(batched, 30);
check("batched posts only full batches", batched.port.posted.length === 2 && batched.port.posted.every((m) => m.length === 1536));
check("batched output is the input, in order", isRamp(flat(batched.port.posted)));

feed(batched, 6, 30 * 128);
check("a full batch completes across process calls", batched.port.posted.length === 3 && isRamp(flat(batched.port.posted)));

const reset = make({ processorOptions: { batchQuanta: 4 } });
feed(reset, 2);
reset.port.onmessage?.({ data: "reset" });
feed(reset, 4, 1000 * 128);
check("reset drops the part-filled batch", reset.port.posted.length === 1 && isRamp(reset.port.posted[0], 1000 * 128));

const odd = make({ processorOptions: { batchQuanta: 2 } });
odd.process([[new Float32Array(200).fill(0.5)]]);
odd.process([[new Float32Array(100).fill(0.25)]]);
check("odd-sized quanta are packed, never dropped", odd.port.posted.length === 1 && flat(odd.port.posted).length === 256);

const stopped = make({ processorOptions: { batchQuanta: 12 } });
stopped.port.onmessage?.({ data: "stop" });
check("stop ends the processor", stopped.process([[quantum]]) === false);

console.log("all pcm worklet checks passed");
