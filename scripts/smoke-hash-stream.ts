/**
 * `hashUnitStream(id)(salt)` must equal `hashUnit(id, salt)` exactly — the constellation layout
 * places every scattered star from these values, so any drift would move stars.
 *
 * No DB, no network, no DOM.
 * Run: npx tsx scripts/smoke-hash-stream.ts
 */
import { hashUnit } from "../src/lib/hash";
import { HASH_STREAM_MAX_SALT, hashUnitStream } from "../src/lib/hash-stream";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) {
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  console.log(`  ok  ${label}`);
}

/** Deterministic pseudo-random, so a failure is always reproducible. */
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const rand = makeRng(7);
const ids: string[] = ["", "a", "deep-space:x", "cluster:Google:3f2a9c1e-6b1d-4e2f-9a8b-1c2d3e4f5a6b"];
for (let i = 0; i < 300; i++) {
  const len = 1 + Math.floor(rand() * 80);
  let s = "";
  for (let j = 0; j < len; j++) s += String.fromCharCode(32 + Math.floor(rand() * 400));
  ids.push(s);
}
const salts = [0, 1, 2, 3, 47, 9_602, HASH_STREAM_MAX_SALT - 1, HASH_STREAM_MAX_SALT, HASH_STREAM_MAX_SALT + 1, 2_000_000, 0.5];
for (let i = 0; i < 200; i++) salts.push(Math.floor(rand() * 20_000));

let mismatches = 0;
let first = "";
for (const id of ids) {
  const stream = hashUnitStream(id);
  for (const salt of salts) {
    const a = stream(salt);
    const b = hashUnit(id, salt);
    if (a !== b) {
      mismatches += 1;
      first ||= `${JSON.stringify(id.slice(0, 20))} salt ${salt}: ${a} vs ${b}`;
    }
  }
}
check(`stream matches hashUnit on ${ids.length} ids x ${salts.length} salts`, mismatches === 0, first);

console.log("\nAll hash-stream smoke checks passed.\n");
process.exit(0);
