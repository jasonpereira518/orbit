/**
 * No proof, no card (docs/superpowers/specs/2026-11-10-radar-analyst-design.md).
 *
 * Every piece of evidence on a card names the reason it backs (`code`) and how it can be
 * trusted (`proof`). This module checks proofs against what the run actually read, in code:
 *   - a quote must appear (whitespace and case aside) in the text the run read from that row;
 *   - a record must be a row the run loaded;
 *   - a link must be one a source row handed over;
 * and in every case the row must have been read FOR THIS CARD'S PERSON. A real quote from a
 * real row about a different person with the same name is not proof: that is exactly how a
 * namesake's news ends up on the wrong card. One row can belong to several people (one email
 * the ranker matched to two contacts, one event they both attend), so each entry holds the set.
 *
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
  /** The person the run read this row for. Omitted only by callers with no person (tests). */
  contactId?: string;
  text?: string | null;
  urls?: readonly string[];
};

type Entry = { texts: string[]; contactIds: Set<string> };

export type ProofIndex = {
  /** `table:id` → the normalized texts read from that row, and who it was read for. */
  rows: ReadonlyMap<string, Readonly<Entry>>;
  /** Links a source handed over (as `safeHttpUrl` returns them) → who they belong to. */
  urls: ReadonlyMap<string, ReadonlySet<string>>;
};

const keyOf = (table: RadarProofTable, id: string) => `${table}:${id}`;

export function buildProofIndex(sources: Iterable<ProofSourceInput>): ProofIndex {
  const rows = new Map<string, Entry>();
  const urls = new Map<string, Set<string>>();
  for (const s of sources) {
    const key = keyOf(s.table, s.id);
    const entry = rows.get(key) ?? { texts: [], contactIds: new Set<string>() };
    const text = s.text ? normalizeForMatch(s.text) : "";
    if (text && !entry.texts.includes(text)) entry.texts.push(text);
    if (s.contactId) entry.contactIds.add(s.contactId);
    rows.set(key, entry);
    for (const u of s.urls ?? []) {
      const safe = safeHttpUrl(u);
      if (!safe) continue;
      const owners = urls.get(safe) ?? new Set<string>();
      if (s.contactId) owners.add(s.contactId);
      urls.set(safe, owners);
    }
  }
  return { rows, urls };
}

/**
 * Whether `owners` lets `contactId` cite the row. A row read for nobody in particular (only
 * tests build those) proves for anyone; a row read for people proves only for them.
 */
function ownedBy(owners: ReadonlySet<string>, contactId: string | undefined): boolean {
  if (owners.size === 0) return true;
  return contactId !== undefined && owners.has(contactId);
}

export function proofHolds(proof: RadarProof | undefined, index: ProofIndex, contactId?: string): boolean {
  if (!proof) return false;
  switch (proof.type) {
    case "record": {
      const entry = index.rows.get(keyOf(proof.table, proof.id));
      return entry !== undefined && ownedBy(entry.contactIds, contactId);
    }
    case "quote": {
      const entry = index.rows.get(keyOf(proof.table, proof.id));
      return entry !== undefined && ownedBy(entry.contactIds, contactId) && entry.texts.some((text) => containsVerbatim(text, proof.quote));
    }
    case "url": {
      const safe = safeHttpUrl(proof.url);
      const owners = safe !== null ? index.urls.get(safe) : undefined;
      return owners !== undefined && ownedBy(owners, contactId);
    }
  }
}

type Checkable = { contactId?: string; reasons: readonly RadarReason[]; evidence: readonly RadarEvidence[] };

/**
 * The card with only its proven evidence, or null when its lead reason is unproven. A card
 * with no lead (only context reasons) is null too: context never makes a card.
 */
export function verifyPick<T extends Checkable>(pick: T, index: ProofIndex): T | null {
  const lead = leadReason(pick.reasons);
  if (!lead) return null;
  // Evidence about someone else (the other side of a Connect card) is checked against them.
  const evidence = pick.evidence.filter((e) => proofHolds(e.proof, index, e.aboutContactId ?? pick.contactId));
  const proven = evidence.filter((e) => e.code === lead.code).length;
  // A Connect card links two notes: it stands only when both sides are proven.
  if (proven < (lead.code.startsWith("connect_") ? 2 : 1)) return null;
  return evidence.length === pick.evidence.length ? pick : { ...pick, evidence };
}

export function verifyPicks<T extends Checkable>(picks: readonly T[], index: ProofIndex): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  for (const pick of picks) {
    const verified = verifyPick(pick, index);
    if (verified) kept.push(verified);
  }
  return { kept, dropped: picks.length - kept.length };
}
