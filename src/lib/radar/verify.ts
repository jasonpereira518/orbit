/**
 * No proof, no card (docs/superpowers/specs/2026-11-10-radar-analyst-design.md).
 *
 * Every piece of evidence on a card names the reason it backs (`code`) and how it can be
 * trusted (`proof`). This module checks proofs against what the run actually read, in code:
 *   - a quote must appear (whitespace and case aside) in the text the run read from that row;
 *   - a record must be a row the run loaded for this account;
 *   - a link must be one a source row handed over.
 * Evidence that fails is stripped. A card whose lead reason is left without proven evidence is
 * dropped. A model may cite a source; it can never make one up, because the index is built
 * only from rows the run read.
 *
 * Pure: the run builds the index from its own signals, so the check costs no statements.
 */
import { safeHttpUrl } from "@/lib/safe-links";
import { leadReason, type RadarEvidence, type RadarProof, type RadarProofTable, type RadarReason } from "@/lib/radar/types";
import { containsVerbatim, normalizeForMatch } from "@/lib/verbatim";

/** A row the run read, as the index needs it. */
export type ProofSourceInput = {
  table: RadarProofTable;
  id: string;
  text?: string | null;
  urls?: readonly string[];
};

export type ProofIndex = {
  /** `table:id` → the normalized texts read from that row (empty for a bare record). */
  rows: ReadonlyMap<string, readonly string[]>;
  /** Links a source handed over, as `safeHttpUrl` returns them. */
  urls: ReadonlySet<string>;
};

const keyOf = (table: RadarProofTable, id: string) => `${table}:${id}`;

export function buildProofIndex(sources: Iterable<ProofSourceInput>): ProofIndex {
  const rows = new Map<string, string[]>();
  const urls = new Set<string>();
  for (const s of sources) {
    const key = keyOf(s.table, s.id);
    const texts = rows.get(key) ?? [];
    const text = s.text ? normalizeForMatch(s.text) : "";
    if (text && !texts.includes(text)) texts.push(text);
    rows.set(key, texts);
    for (const u of s.urls ?? []) {
      const safe = safeHttpUrl(u);
      if (safe) urls.add(safe);
    }
  }
  return { rows, urls };
}

export function proofHolds(proof: RadarProof | undefined, index: ProofIndex): boolean {
  if (!proof) return false;
  switch (proof.type) {
    case "record":
      return index.rows.has(keyOf(proof.table, proof.id));
    case "quote": {
      const texts = index.rows.get(keyOf(proof.table, proof.id));
      return Boolean(texts?.some((text) => containsVerbatim(text, proof.quote)));
    }
    case "url": {
      const safe = safeHttpUrl(proof.url);
      return safe !== null && index.urls.has(safe);
    }
  }
}

/**
 * The card with only its proven evidence, or null when its lead reason is unproven. A card
 * with no lead (only context reasons) is null too: context never makes a card.
 */
export function verifyPick<T extends { reasons: readonly RadarReason[]; evidence: readonly RadarEvidence[] }>(
  pick: T,
  index: ProofIndex
): T | null {
  const lead = leadReason(pick.reasons);
  if (!lead) return null;
  const evidence = pick.evidence.filter((e) => proofHolds(e.proof, index));
  if (!evidence.some((e) => e.code === lead.code)) return null;
  return evidence.length === pick.evidence.length ? pick : { ...pick, evidence };
}

export function verifyPicks<T extends { reasons: readonly RadarReason[]; evidence: readonly RadarEvidence[] }>(
  picks: readonly T[],
  index: ProofIndex
): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  for (const pick of picks) {
    const verified = verifyPick(pick, index);
    if (verified) kept.push(verified);
  }
  return { kept, dropped: picks.length - kept.length };
}
