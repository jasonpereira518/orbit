/**
 * The instant half of constellation search.
 *
 * Pure string work, deliberately: it runs on every keystroke, before the semantic search
 * round-trip lands, so the sky reacts while you are still typing. Shared by both
 * renderers — a phone and a laptop must agree about who a query matches — and pinned by
 * `scripts/smoke-graph-canvas.ts`.
 */
import type { GraphNodeData } from "@/lib/graph-layout";
import type { GraphContact, GraphCluster } from "@/components/graph/graph-chart-types";

export function contactMatchesLocal(d: GraphNodeData, q: string): boolean {
  if (!q) return true;
  const hay = [
    d.label,
    d.fullName,
    d.preferredName,
    d.company,
    d.school,
    d.title,
    d.aiSummary,
    d.howMet,
    d.metContext,
    d.email,
    d.phone,
    d.linkedinUrl,
    d.website,
    d.clusterName,
    ...(d.tags || []),
    ...(d.keyFacts || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const phrase = q.trim().toLowerCase();
  if (!phrase) return true;
  if (hay.includes(phrase)) return true;
  const tokens = phrase
    .split(/[^a-z0-9+#.]+/i)
    .filter((t) => t.length > 1);
  if (tokens.length === 0) return false;
  return tokens.every((t) => hay.includes(t));
}

/**
 * What the chart payload carries to match on. How someone was met, their contact details
 * and interests are not in it (they are fetched for the one star the inspect panel opens),
 * so a query about those is answered by the server search the graph runs after a pause.
 */
function contactSearchHaystack(c: GraphContact): string {
  return [
    c.fullName,
    c.preferredName,
    c.company,
    c.school,
    c.title,
    c.aiSummary,
    ...(c.tags || []),
    ...(c.keyFacts || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export type ContactSearchRecord = {
  haystack: string;
  name: string;
  words: string[];
};

export function buildContactHaystackIndex(
  contacts: GraphContact[]
): Map<string, ContactSearchRecord> {
  const index = new Map<string, ContactSearchRecord>();
  for (const c of contacts) {
    const haystack = contactSearchHaystack(c);
    const name = [c.fullName, c.preferredName].filter(Boolean).join(" ").toLowerCase();
    const words = name ? name.split(/\s+/).filter(Boolean) : [];
    index.set(c.id, { haystack, name, words });
  }
  return index;
}

/**
 * Bounded Levenshtein distance for typo tolerance. Name words are short, so
 * a two-row DP with an early exit is plenty.
 */
function withinEditDistance(a: string, b: string, max: number): boolean {
  if (max <= 0) return a === b;
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

/** Allowed typos scale with how much of the name has been typed. */
function typoBudget(token: string) {
  return token.length >= 7 ? 2 : token.length >= 4 ? 1 : 0;
}

/** Plain Levenshtein distance — name-sized strings only. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * A query only "completes" a name once it's this close (in edits) to being
 * the whole thing. Below this, any edit-distance gap between candidates is
 * just an artifact of their differing name lengths, not a real signal.
 */
const NAME_LOCK_MAX_DIST = 2;

/**
 * Once the query is close to a *complete* name and one candidate fits it
 * decisively better than every other, keep only that one — "Viktor Larsen"
 * should not also highlight the other Larsens. While the query is still a
 * short/partial fragment of a much longer name, every candidate's edit
 * distance is large regardless of how good a fit they are, so this never
 * fires early: "Larsen" alone keeps every Larsen highlighted, and only
 * something close to a full name locks onto one.
 */
function dominantNameHit<T>(
  hits: T[],
  nameOf: (hit: T) => string,
  phrase: string
): T[] {
  if (hits.length <= 1) return hits;
  const scored = hits
    .map((hit) => ({ hit, dist: editDistance(nameOf(hit), phrase) }))
    .sort((a, b) => a.dist - b.dist);
  const [best, second] = scored;
  if (best.dist > NAME_LOCK_MAX_DIST) return hits;
  if (second.dist - best.dist >= 2) return [best.hit];
  return hits;
}

/** Does a query token match a name word, tolerating typos and partial typing? */
function fuzzyNameWordMatch(word: string, token: string) {
  if (word.startsWith(token)) return true;
  const budget = typoBudget(token);
  if (budget === 0) return false;
  if (withinEditDistance(word, token, budget)) return true;
  // Partial typing with a typo: compare against the same-length prefix
  // ("victo" ↔ "vikto" while typing toward Viktor).
  return (
    token.length >= 4 &&
    word.length > token.length &&
    withinEditDistance(word.slice(0, token.length), token, budget)
  );
}

export type GraphContactMatch = {
  ids: string[];
  /** True when the hits came from the name tiers (exact or fuzzy). */
  nameTier: boolean;
};

export function matchGraphContacts(
  contacts: GraphContact[],
  query: string,
  haystackById: Map<string, string | ContactSearchRecord>
): GraphContactMatch {
  const phrase = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!phrase) return { ids: [], nameTier: false };
  const tokens = phrase
    .split(/[^a-z0-9+#.]+/i)
    .filter((t) => t.length > 1);

  const getRecord = (c: GraphContact): ContactSearchRecord => {
    const hit = haystackById.get(c.id);
    if (hit && typeof hit === "object") return hit;
    const name = [c.fullName, c.preferredName].filter(Boolean).join(" ").toLowerCase();
    return {
      haystack: (typeof hit === "string" ? hit : undefined) ?? contactSearchHaystack(c),
      name,
      words: name ? name.split(/\s+/).filter(Boolean) : [],
    };
  };

  // Names take precedence: "Viktor Larsen" should land on Viktor Larsen,
  // not also on everyone whose notes mention a Viktor or a Larsen. Within a
  // name tier, one decisively-best fit wins alone.
  const exactNameHits: Array<{ contact: GraphContact; record: ContactSearchRecord }> = [];
  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];
    const rec = getRecord(c);
    if (rec.name.includes(phrase)) {
      exactNameHits.push({ contact: c, record: rec });
    }
  }

  if (exactNameHits.length > 0) {
    const dominant = dominantNameHit(
      exactNameHits,
      (item) => item.record.name,
      phrase
    );
    return {
      ids: dominant.map((item) => item.contact.id),
      nameTier: true,
    };
  }

  // Typo-tolerant name pass: every token must fuzzily match one of the
  // contact's name words ("Victor Larson" still finds Viktor Larsen).
  if (tokens.length > 0) {
    const fuzzyNameHits: Array<{ contact: GraphContact; record: ContactSearchRecord }> = [];
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      const rec = getRecord(c);
      const words = rec.words;
      if (words.length > 0 && tokens.every((t) => words.some((w) => fuzzyNameWordMatch(w, t)))) {
        fuzzyNameHits.push({ contact: c, record: rec });
      }
    }
    if (fuzzyNameHits.length > 0) {
      const dominant = dominantNameHit(
        fuzzyNameHits,
        (item) => item.record.name,
        phrase
      );
      return {
        ids: dominant.map((item) => item.contact.id),
        nameTier: true,
      };
    }
  }

  const ids: string[] = [];
  const tokenLen = tokens.length;
  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];
    const rec = getRecord(c);
    const hay = rec.haystack;
    if (hay.includes(phrase)) {
      ids.push(c.id);
      continue;
    }
    if (tokenLen === 0) continue;
    if (tokenLen === 1) {
      if (hay.includes(tokens[0])) ids.push(c.id);
      continue;
    }
    // Multi-word: prefer all tokens; allow strong partial if ≥2 long tokens hit
    if (tokens.every((t) => hay.includes(t))) {
      ids.push(c.id);
      continue;
    }
    let strongHits = 0;
    for (let j = 0; j < tokenLen; j++) {
      const t = tokens[j];
      if (t.length >= 4 && hay.includes(t)) {
        strongHits++;
        if (strongHits >= 2) {
          ids.push(c.id);
          break;
        }
      }
    }
  }
  return { ids, nameTier: false };
}

/**
 * Whether a query that names this cluster exactly should highlight the whole cluster instead
 * of running person matching. Role clusters are excluded: "Product" and "Operations" are also
 * function words, and a search for them should still find those people inside company
 * clusters, not just the cross-company role cluster.
 */
export function isExactClusterShortcut(cluster: GraphCluster, query: string): boolean {
  if (cluster.kind === "role") return false;
  return cluster.name.toLowerCase() === query.trim().toLowerCase().replace(/\s+/g, " ");
}

export function findClusterMatch(
  clusters: GraphCluster[],
  query: string
): GraphCluster | null {
  const phrase = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!phrase || clusters.length === 0) return null;

  const exact = clusters.find((c) => c.name.toLowerCase() === phrase);
  if (exact) return exact;

  const starts = clusters.filter((c) =>
    c.name.toLowerCase().startsWith(phrase)
  );
  if (starts.length === 1) return starts[0];

  const includes = clusters
    .filter((c) => {
      const name = c.name.toLowerCase();
      return name.includes(phrase) || phrase.includes(name);
    })
    .sort((a, b) => a.name.length - b.name.length);
  if (includes.length === 1) return includes[0];
  if (includes.length > 1 && phrase.length >= 3) {
    // Prefer the shortest name that still contains the query (e.g. "AWS")
    return includes[0];
  }
  return null;
}
