/**
 * The command palette's matching rules — pure, so `scripts/smoke-command-palette.ts` can pin
 * them without a browser. The palette itself is `src/components/layout/command-palette.tsx`.
 */
import { surfaceForPathname, surfaceKeyForSettingsId } from "@/lib/surfaces";

export type PaletteEntry = {
  id: string;
  label: string;
  /** Extra words that should find this entry without being shown. */
  keywords?: string;
  /** Where it goes. Also what decides whether a hidden surface removes it. */
  href?: string;
  /** Settings anchors are hidden by section, not by page. */
  settingsId?: string;
};

function normalize(s: string) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * How well `query` matches an entry, or 0 for no match. Every word of the query must hit
 * somewhere (label or keywords) — "new rem" finds "New reminder", "rem new" does too, and
 * "new zebra" finds nothing rather than every entry containing "new".
 *
 * Ranking, per word: the label starting with it beats a word in the label starting with
 * it beats it appearing anywhere in the label beats it only matching a keyword.
 */
export function scoreEntry(query: string, entry: Pick<PaletteEntry, "label" | "keywords">): number {
  const q = normalize(query);
  if (!q) return 1;
  const label = normalize(entry.label);
  const keywords = normalize(entry.keywords ?? "");
  const labelWords = label.split(/[\s/·›&,-]+/).filter(Boolean);
  let score = 0;
  for (const word of q.split(" ")) {
    if (label.startsWith(word)) score += 8;
    else if (labelWords.some((w) => w.startsWith(word))) score += 5;
    else if (label.includes(word)) score += 3;
    else if (keywords.split(/\s+/).some((k) => k.startsWith(word))) score += 2;
    else if (keywords.includes(word)) score += 1;
    else return 0;
  }
  // The whole query as typed, in order, is a stronger signal than its words scattered.
  if (label.startsWith(q)) score += 4;
  return score;
}

/** Entries matching `query`, best first; ties keep their declared order. */
export function rankEntries<T extends PaletteEntry>(entries: T[], query: string): T[] {
  if (!normalize(query)) return entries;
  return entries
    .map((entry, index) => ({ entry, index, score: scoreEntry(query, entry) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((r) => r.entry);
}

/**
 * Drops entries that lead somewhere an operator has hidden from this viewer — the palette
 * must not become a side door into a surface the nav no longer shows.
 */
export function visibleEntries<T extends PaletteEntry>(entries: T[], hidden: ReadonlySet<string>): T[] {
  return entries.filter((entry) => {
    if (entry.settingsId && hidden.has(surfaceKeyForSettingsId(entry.settingsId))) return false;
    if (!entry.href) return true;
    const path = entry.href.split(/[?#]/)[0]!;
    const surface = surfaceForPathname(path);
    return !surface || !hidden.has(surface.key);
  });
}

const QUESTION_START =
  /^(who|whom|whose|what|which|when|where|why|how|does|do|did|is|are|was|were|can|could|should|would|will|has|have|any|find|show|list|tell)\b/i;

/**
 * Whether the text reads as a question for the network rather than a place to go. Decides
 * whether "Ask your network" leads the results or trails them — never whether it is shown.
 */
export function looksLikeQuestion(query: string): boolean {
  const q = query.trim();
  if (q.length < 4) return false;
  return q.endsWith("?") || (QUESTION_START.test(q) && q.split(/\s+/).length >= 3);
}
