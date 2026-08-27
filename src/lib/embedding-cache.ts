import { createHash } from "node:crypto";
import { createEmbedding } from "@/lib/ai";

/**
 * In-memory LRU for query embeddings. Fluid Compute reuses function instances
 * across requests, so a module-level cache gets a real hit rate: incremental
 * ask-bar typing and repeated chat phrasings skip the external embedding call.
 * Values are per-user (embedding backend is resolved from user settings).
 */
type Entry = { value: number[]; expiresAt: number };

const MAX_ENTRIES = 500;
const TTL_MS = 60 * 60 * 1000;

const globalForCache = globalThis as unknown as {
  orbitQueryEmbeddingCache?: Map<string, Entry>;
};

function cache(): Map<string, Entry> {
  if (!globalForCache.orbitQueryEmbeddingCache) {
    globalForCache.orbitQueryEmbeddingCache = new Map();
  }
  return globalForCache.orbitQueryEmbeddingCache;
}

export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

function cacheKey(userId: string, query: string): string {
  return createHash("sha256")
    .update(`${userId}\n${normalizeQuery(query)}`)
    .digest("hex");
}

export async function getQueryEmbedding(
  userId: string,
  query: string,
  embed: (userId: string, text: string) => Promise<number[]> = createEmbedding
): Promise<number[]> {
  const key = cacheKey(userId, query);
  const store = cache();
  const now = Date.now();

  const hit = store.get(key);
  if (hit && hit.expiresAt > now) {
    // Re-insert to refresh LRU position (Map preserves insertion order).
    store.delete(key);
    store.set(key, hit);
    return hit.value;
  }
  if (hit) store.delete(key);

  const value = await embed(userId, query);
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { value, expiresAt: now + TTL_MS });
  return value;
}

export function __clearEmbeddingCacheForTests() {
  cache().clear();
}
