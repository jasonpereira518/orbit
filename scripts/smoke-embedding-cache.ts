/**
 * Exercises the query-embedding LRU: hit, miss, normalization, TTL, eviction.
 * No DB, no network. Run: npx tsx scripts/smoke-embedding-cache.ts
 */
import {
  getQueryEmbedding,
  normalizeQuery,
  __clearEmbeddingCacheForTests,
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

  check("normalize collapses whitespace + case", normalizeQuery("  Who   KNOWS ai ") === "who knows ai");

  const a = await getQueryEmbedding("u1", "who knows AI", stub);
  const b = await getQueryEmbedding("u1", "  who knows ai ", stub);
  check("second call served from cache", calls === 1);
  check("cached value identical", a === b);

  await getQueryEmbedding("u2", "who knows AI", stub);
  check("different user is a different key", calls === 2);

  await getQueryEmbedding("u1", "different query", stub);
  check("different query misses", calls === 3);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
