import { createHash } from "node:crypto";
import type { GraphContactInput } from "@/lib/graph-layout";
import { peerLinkSummary, type PeerLinkSummary } from "@/lib/network-metrics";

/**
 * Per-instance copy of the dashboard's peer-link analysis.
 *
 * `peerLinkSummary` compares every pair in the metrics sample (up to
 * `METRICS_MAX_CONTACTS`): ~0.7 s of every `/dashboard` render at 100k contacts and ~0.1 s
 * at 10k, for an answer that changes only when one of those contacts does. Keyed by a hash
 * of the exact rows it reads, so any edit to a sampled contact (or a change in who is
 * sampled) is a miss; nothing is ever served for inputs it was not computed from.
 */
const MAX_ENTRIES = 200;
const memo = new Map<string, PeerLinkSummary>();

export function rememberedPeerLinkSummary(sampled: GraphContactInput[]): PeerLinkSummary {
  const key = createHash("sha256").update(JSON.stringify(sampled)).digest("base64");
  const hit = memo.get(key);
  if (hit) {
    // Most recently used goes to the back, so eviction takes the stalest.
    memo.delete(key);
    memo.set(key, hit);
    return hit;
  }
  const summary = peerLinkSummary(sampled);
  if (memo.size >= MAX_ENTRIES) memo.delete(memo.keys().next().value!);
  memo.set(key, summary);
  return summary;
}
