/**
 * Exercises the query-embedding LRU: hit, miss, normalization, TTL, eviction.
 * No DB, no network. Run: npx tsx scripts/smoke-embedding-cache.ts
 */
import {
  getQueryEmbedding,
  normalizeQuery,
  __clearEmbeddingCacheForTests,
  __setNowForTests,
} from "../src/lib/embedding-cache";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  __clearEmbeddingCacheForTests();
  let calls = 0;
  const stub = async (_userId: string, text: string) => {
    calls += 1;
    return [text.length, calls, 0];
  };
  // Stub scope resolver: no DB access, fixed scope unless a test overrides it.
  const scopeStub = async () => "stub";

  check("normalize collapses whitespace + case", normalizeQuery("  Who   KNOWS ai ") === "who knows ai");

  const a = await getQueryEmbedding("u1", "who knows AI", stub, scopeStub);
  const b = await getQueryEmbedding("u1", "  who knows ai ", stub, scopeStub);
  check("second call served from cache", calls === 1);
  check("cached value identical", a === b);

  await getQueryEmbedding("u2", "who knows AI", stub, scopeStub);
  check("different user is a different key", calls === 2);

  await getQueryEmbedding("u1", "different query", stub, scopeStub);
  check("different query misses", calls === 3);

  // Backend switch: same user + query, different scope (e.g. openai -> gemini)
  // must miss the cache rather than serving back a stale-model vector.
  await getQueryEmbedding("u1", "who knows AI", stub, async () => "other-scope");
  check("different scope for same user+query misses", calls === 4);

  // TTL expiry: advance the injected clock past TTL_MS (1h) and confirm re-embed.
  __clearEmbeddingCacheForTests();
  calls = 0;
  let fakeNow = 1_000_000;
  __setNowForTests(() => fakeNow);
  await getQueryEmbedding("u1", "ttl query", stub, scopeStub);
  fakeNow += 30 * 60 * 1000; // 30 min: still fresh
  await getQueryEmbedding("u1", "ttl query", stub, scopeStub);
  check("entry still fresh before TTL", calls === 1);
  fakeNow += 31 * 60 * 1000; // total 61 min: expired
  await getQueryEmbedding("u1", "ttl query", stub, scopeStub);
  check("entry expires after TTL", calls === 2);
  __setNowForTests(null);

  // LRU eviction: fill to MAX_ENTRIES (500), oldest key falls out.
  __clearEmbeddingCacheForTests();
  calls = 0;
  await getQueryEmbedding("u1", "first key", stub, scopeStub);
  for (let i = 0; i < 500; i++) {
    await getQueryEmbedding("u1", `filler ${i}`, stub, scopeStub);
  }
  const callsAfterFill = calls;
  await getQueryEmbedding("u1", "first key", stub, scopeStub);
  check("oldest entry evicted at capacity", calls === callsAfterFill + 1);
  await getQueryEmbedding("u1", "filler 499", stub, scopeStub);
  check("newest entry survives eviction", calls === callsAfterFill + 1);

  // Soft deadline: a slow embedding fails fast for the caller, yet still lands in the cache.
  __clearEmbeddingCacheForTests();
  let slowCalls = 0;
  const slow = async () => {
    slowCalls++;
    await new Promise((r) => setTimeout(r, 120));
    return [0.5, 0.5];
  };
  let timedOut = false;
  try {
    await getQueryEmbedding("u1", "slow query", slow, scopeStub, { softTimeoutMs: 20 });
  } catch (err) {
    timedOut = err instanceof Error && /embedding timeout/.test(err.message);
  }
  check("a slow embedding fails fast once the soft deadline passes", timedOut);
  await new Promise((r) => setTimeout(r, 200));
  const late = await getQueryEmbedding("u1", "slow query", slow, scopeStub, { softTimeoutMs: 20 });
  check("its late answer was cached for the next ask", slowCalls === 1 && late[0] === 0.5, String(slowCalls));
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
