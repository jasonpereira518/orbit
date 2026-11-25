/**
 * Radar v2 Semantic Network Matcher.
 *
 * Replaces shallow keyword-substring matching over `(title, company, industry)` with
 * multi-signal semantic & structured matching across:
 *   1. `contact_embeddings` (pgvector HNSW on Neon, bounded JS cosine on PGlite)
 *   2. `memory_chunks` (hybrid semantic + lexical retrieval over notes & messages)
 *   3. `relationship_digests` (`working_on`, `topics`, `what_they_do`) + `contact_profiles` (`skills`)
 *
 * Degrades gracefully without an embedding key (Anthropic-only or no AI key): falls back
 * to lexical `searchMemories` + digest/profile token overlap and never throws.
 * Never selects `contacts.notes` or `interactions.raw_notes`.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, isPgvectorAvailable, rowsOf } from "@/db";
import { contactEmbeddings, memoryChunks } from "@/db/schema";
import { cosineSimilarity, createEmbedding } from "@/lib/ai";
import type { AiAccess } from "@/lib/ai-access";
import { withAiResultCache } from "@/lib/ai-result-cache";
import { cleanSingleLine } from "@/lib/ai-security";
import { SEMANTIC_SIMILARITY_FLOOR } from "@/lib/hybrid-search";
import { searchMemories } from "@/lib/memory-search";
import { metContactSql } from "@/lib/met-contact";
import { formatVectorLiteral } from "@/lib/pgvector";
import { scoreProjectMatch, type UserProject } from "@/lib/projects/store";
import { contentTokens } from "@/lib/search-tokens";
import type { RadarSignal, RadarSteering } from "@/lib/radar/types";

const MAX_SEMANTIC_CONTACTS = 60;
const IN_MEMORY_SCAN_LIMIT = 1_500;
const EMBED_CACHE_DAYS = 7;
const CHUNK_LOOKBACK_DAYS = 180;
const DAY_MS = 86_400_000;

export type SemanticContactHit = {
  contactId: string;
  /** 0..1 combined semantic + project/digest relevance. */
  similarity: number;
  matchedLabels: string[];
  projectTitle: string | null;
  proof?: {
    table: "memory_chunks" | "relationship_digests" | "contacts";
    id: string;
    text?: string | null;
    quote?: string | null;
  };
};

export type SemanticMatchResult = {
  byContact: Map<string, SemanticContactHit>;
  signals: RadarSignal[];
};

export function buildIntentText(opts: {
  goals: readonly string[];
  projects: readonly UserProject[];
  steering?: RadarSteering | null;
}): string {
  const parts: string[] = [];
  for (const g of opts.goals.slice(0, 6)) {
    const clean = cleanSingleLine(g, 160);
    if (clean) parts.push(clean);
  }
  for (const p of opts.projects.slice(0, 5)) {
    const line = [p.title, p.summary, p.topics.slice(0, 6).join(", ")].filter(Boolean).join(" — ");
    const clean = cleanSingleLine(line, 240);
    if (clean) parts.push(clean);
  }
  const s = opts.steering;
  if (s?.topics?.length) parts.push(`Topics: ${s.topics.slice(0, 8).join(", ")}`);
  if (s?.targetRoles?.length) parts.push(`Target roles: ${s.targetRoles.slice(0, 6).join(", ")}`);
  if (s?.targetOrgs?.length) parts.push(`Target organizations: ${s.targetOrgs.slice(0, 6).join(", ")}`);
  return parts.join("\n").slice(0, 2_000);
}

async function cachedIntentEmbedding(
  userId: string,
  intentText: string,
  access?: AiAccess | null
): Promise<number[] | null> {
  if (!access || !intentText.trim()) return null;
  try {
    const key = { v: 1, kind: "radar-intent", hash: createHash("sha256").update(intentText).digest("hex").slice(0, 24) };
    const vec = await withAiResultCache<number[] | null>(
      userId,
      "search.embed",
      key,
      async () => {
        try {
          return await createEmbedding(userId, intentText, access);
        } catch {
          return null;
        }
      },
      { ttlDays: EMBED_CACHE_DAYS, accept: (v) => Array.isArray(v) && v.length > 0 }
    );
    return Array.isArray(vec) && vec.length > 0 ? vec : null;
  } catch {
    return null;
  }
}

async function queryContactVectors(
  userId: string,
  embedding: number[],
  limit: number
): Promise<Map<string, number>> {
  const db = await getDb();
  const out = new Map<string, number>();

  if (isPgvectorAvailable()) {
    const literal = formatVectorLiteral(embedding);
    const scanLimit = Math.max(limit * 4, 80);
    const result = await db.execute(sql`
      SELECT contact_id, 1 - min(distance) AS sim
        FROM (
          SELECT contact_id, embedding_vector <=> ${literal}::vector AS distance
            FROM contact_embeddings
           WHERE user_id = ${userId}
             AND embedding_vector IS NOT NULL
           ORDER BY embedding_vector <=> ${literal}::vector
           LIMIT ${scanLimit}
        ) nearest
       GROUP BY contact_id
      HAVING 1 - min(distance) > ${SEMANTIC_SIMILARITY_FLOOR}
       ORDER BY sim DESC
       LIMIT ${limit}
    `);
    for (const r of rowsOf<{ contact_id: string; sim: number | string }>(result)) {
      out.set(r.contact_id, Math.max(0, Math.min(1, Number(r.sim))));
    }
    return out;
  }

  const rows = await db.query.contactEmbeddings.findMany({
    where: eq(contactEmbeddings.userId, userId),
    columns: { contactId: true, embedding: true },
    limit: IN_MEMORY_SCAN_LIMIT,
  });
  const best = new Map<string, number>();
  for (const row of rows) {
    if (!row.embedding?.length) continue;
    const sim = cosineSimilarity(embedding, row.embedding);
    if (sim <= SEMANTIC_SIMILARITY_FLOOR) continue;
    const prev = best.get(row.contactId) ?? 0;
    if (sim > prev) best.set(row.contactId, sim);
  }
  const sorted = [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  for (const [id, sim] of sorted) out.set(id, sim);
  return out;
}

/**
 * Matches the user's active goals, active projects, and steering against met contacts using
 * vector embeddings, memory chunks, relationship digests, and profile skills.
 */
export async function findSemanticMatches(
  userId: string,
  opts: {
    goals: readonly string[];
    projects: readonly UserProject[];
    steering?: RadarSteering | null;
    now: Date;
    access?: AiAccess | null;
  }
): Promise<SemanticMatchResult> {
  const intentText = buildIntentText(opts);
  const byContact = new Map<string, SemanticContactHit>();
  if (!intentText.trim()) return { byContact, signals: [] };

  const db = await getDb();
  const avoid = new Set((opts.steering?.avoidTopics ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean));
  const embedding = await cachedIntentEmbedding(userId, intentText, opts.access);

  const queryTerms = [
    ...opts.goals.slice(0, 4),
    ...opts.projects.slice(0, 4).flatMap((p) => [p.title, ...p.topics.slice(0, 3)]),
    ...(opts.steering?.topics ?? []).slice(0, 5),
    ...(opts.steering?.targetRoles ?? []).slice(0, 3),
  ]
    .join(" ")
    .slice(0, 400);

  const [vectorHits, memoryHits, digestRows, metRows] = await Promise.all([
    embedding ? queryContactVectors(userId, embedding, MAX_SEMANTIC_CONTACTS).catch(() => new Map<string, number>()) : Promise.resolve(new Map<string, number>()),
    queryTerms.trim()
      ? searchMemories(userId, {
          query: queryTerms,
          embedding,
          after: new Date(opts.now.getTime() - CHUNK_LOOKBACK_DAYS * DAY_MS),
          limit: 24,
        }).catch(() => [])
      : Promise.resolve([]),
    db.execute(sql`
      SELECT d.contact_id, d.what_they_do, d.working_on, d.topics, p.skills, p.headline
        FROM relationship_digests d
        JOIN contacts c ON c.id = d.contact_id AND c.user_id = d.user_id
        LEFT JOIN contact_profiles p ON p.contact_id = d.contact_id AND p.user_id = d.user_id
       WHERE d.user_id = ${userId}
         AND c.constellation_pin IS DISTINCT FROM 'out'
         AND ${metContactSql(sql`c.id`, userId)}
         AND (d.working_on IS NOT NULL OR d.what_they_do IS NOT NULL OR jsonb_array_length(d.topics) > 0 OR p.headline IS NOT NULL)
       LIMIT 400
    `),
    db.execute(sql`
      SELECT id FROM contacts
       WHERE user_id = ${userId}
         AND constellation_pin IS DISTINCT FROM 'out'
         AND ${metContactSql(sql`contacts.id`, userId)}
       LIMIT 2500
    `),
  ]);

  const metSet = new Set(rowsOf<{ id: string }>(metRows).map((r) => r.id));

  // Fetch exact chunk content for any memory hits so quote proofs are verbatim against stored rows.
  const chunkIds = [...new Set(memoryHits.map((m) => m.chunkId))];
  const chunkTextById = new Map<string, { content: string; occurredAt: Date | null }>();
  if (chunkIds.length > 0) {
    const chunkRows = await db
      .select({ id: memoryChunks.id, content: memoryChunks.content, occurredAt: memoryChunks.occurredAt })
      .from(memoryChunks)
      .where(and(eq(memoryChunks.userId, userId), inArray(memoryChunks.id, chunkIds)));
    for (const c of chunkRows) chunkTextById.set(c.id, { content: c.content, occurredAt: c.occurredAt });
  }

  const intentTokens = new Set(contentTokens(intentText).map((t) => t.toLowerCase()));

  const ensureHit = (contactId: string): SemanticContactHit => {
    let hit = byContact.get(contactId);
    if (!hit) {
      hit = { contactId, similarity: 0, matchedLabels: [], projectTitle: null };
      byContact.set(contactId, hit);
    }
    return hit;
  };

  for (const [contactId, sim] of vectorHits) {
    if (!metSet.has(contactId)) continue;
    const hit = ensureHit(contactId);
    hit.similarity = Math.max(hit.similarity, sim);
    if (!hit.proof) hit.proof = { table: "contacts", id: contactId };
  }

  for (const m of memoryHits) {
    const full = chunkTextById.get(m.chunkId);
    if (!full) continue;
    const quote = cleanSingleLine(full.content, 180);
    if (!quote) continue;
    const lower = full.content.toLowerCase();
    if ([...avoid].some((term) => lower.includes(term))) continue;
    const proj = scoreProjectMatch(opts.projects, full.content);
    for (const cid of m.contactIds) {
      if (!metSet.has(cid)) continue;
      const hit = ensureHit(cid);
      const boost = Math.min(0.85, 0.35 + (proj.score > 0 ? 0.25 : 0));
      hit.similarity = Math.max(hit.similarity, boost);
      if (proj.bestProject && !hit.projectTitle) hit.projectTitle = proj.bestProject.title;
      if (proj.bestProject && !hit.matchedLabels.includes(proj.bestProject.title)) {
        hit.matchedLabels.push(proj.bestProject.title);
      }
      if (!hit.proof || hit.proof.table === "contacts") {
        hit.proof = { table: "memory_chunks", id: m.chunkId, text: full.content, quote };
      }
    }
  }

  for (const r of rowsOf<{
    contact_id: string;
    what_they_do: string | null;
    working_on: string | null;
    topics: Array<{ label?: string; name?: string }> | null;
    skills: Array<{ name?: string }> | null;
    headline: string | null;
  }>(digestRows)) {
    const topicNames = (Array.isArray(r.topics) ? r.topics : []).map((t) => t?.label ?? t?.name).filter((n): n is string => Boolean(n));
    const skillNames = (Array.isArray(r.skills) ? r.skills : []).map((s) => s?.name).filter((n): n is string => Boolean(n));
    const blob = [r.working_on, r.what_they_do, r.headline, ...topicNames, ...skillNames].filter(Boolean).join(" ");
    if (!blob.trim()) continue;
    const lower = blob.toLowerCase();
    if ([...avoid].some((term) => lower.includes(term))) continue;

    const proj = scoreProjectMatch(opts.projects, blob);
    const tokens = contentTokens(blob).map((t) => t.toLowerCase());
    const overlap = tokens.filter((t) => intentTokens.has(t));
    const steeringTopics = (opts.steering?.topics ?? []).filter((t) => lower.includes(t.toLowerCase()));

    const tokenScore = overlap.length > 0 ? Math.min(0.65, 0.22 + overlap.length * 0.08) : 0;
    const projScore = proj.score > 0 ? Math.min(0.8, 0.3 + proj.score * 0.015) : 0;
    const steerScore = steeringTopics.length > 0 ? Math.min(0.85, 0.4 + steeringTopics.length * 0.12) : 0;
    const combined = Math.max(tokenScore, projScore, steerScore);
    if (combined < 0.28 && !byContact.has(r.contact_id)) continue;

    const hit = ensureHit(r.contact_id);
    hit.similarity = Math.max(hit.similarity, combined);
    if (proj.bestProject && !hit.projectTitle) hit.projectTitle = proj.bestProject.title;
    for (const label of [...steeringTopics, ...proj.matchedKeywords].slice(0, 3)) {
      if (!hit.matchedLabels.includes(label)) hit.matchedLabels.push(label);
    }
    const quoteSource = cleanSingleLine(r.working_on ?? r.what_they_do ?? null, 180);
    if (quoteSource && (!hit.proof || hit.proof.table === "contacts")) {
      hit.proof = {
        table: "relationship_digests",
        id: r.contact_id,
        text: r.working_on ?? r.what_they_do ?? "",
        quote: quoteSource,
      };
    }
  }

  // Emit `semantic_match` signals only for high-confidence hits backed by verifiable proof.
  const ranked = [...byContact.values()]
    .filter((h) => h.similarity >= 0.42 && h.proof)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 20);

  const signals: RadarSignal[] = ranked.map((h) => ({
    kind: "semantic_match",
    contactId: h.contactId,
    at: opts.now,
    similarity: Number(h.similarity.toFixed(2)),
    matchedLabels: h.matchedLabels.slice(0, 3),
    projectTitle: h.projectTitle,
    source: h.proof,
  }));

  return { byContact, signals };
}
