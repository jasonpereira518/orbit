/**
 * Citations for a chat answer: `[e7]` markers that point at the specific note or interaction
 * a claim came from.
 *
 * The ledger is minted from what the model is actually SHOWN, after every cap and trim has
 * already run — never from the underlying rows before budgeting. A ledger built any other
 * way could contain a source the model never saw, which would make a citation unfalsifiable:
 * the marker would look verified but prove nothing. See `buildChatPrompt` (@/lib/ai) for
 * where minting happens, and `budgetContactsContext` (@/lib/chat-retrieval) for the caps it
 * happens after.
 *
 * Ids are deduplicated by source identity, so the same interaction cited from a contact's
 * timeline and again from a research passage gets ONE id, not two — a person clicking a
 * later chip and an earlier chip for "the same coffee" would otherwise land on two different,
 * confusingly identical snippets.
 */

export type EvidenceSource =
  | {
      kind: "interaction";
      /** `interactions.id`. */
      sourceId: string;
      contactId: string | null;
      /** ISO day, for display; not re-derived from `sourceId` at render time. */
      date: string | null;
    }
  | {
      kind: "contact";
      /** The contact's summary, notes and key facts as a whole — not one dated event. */
      contactId: string;
    };

function keyOf(source: EvidenceSource): string {
  return source.kind === "interaction" ? `interaction:${source.sourceId}` : `contact:${source.contactId}`;
}

export type EvidenceLedger = {
  /** Returns the source's id, minting a new one only if this exact source hasn't been cited yet. */
  mint: (source: EvidenceSource) => string;
  resolve: (id: string) => EvidenceSource | undefined;
  /** Every source minted so far, in minting order. */
  entries: () => ReadonlyMap<string, EvidenceSource>;
};

export function createEvidenceLedger(): EvidenceLedger {
  const byKey = new Map<string, string>();
  const byId = new Map<string, EvidenceSource>();
  let next = 1;
  return {
    mint(source) {
      const key = keyOf(source);
      const existing = byKey.get(key);
      if (existing) return existing;
      const id = `e${next++}`;
      byKey.set(key, id);
      byId.set(id, source);
      return id;
    },
    resolve(id) {
      return byId.get(id);
    },
    entries() {
      return byId;
    },
  };
}

/** A citation marker: `[e7]`, `[e12]`. Never matches inside a longer token like `[e7a]`. */
const MARKER_RE = /\[e(\d+)\]/g;

/** Every distinct `[eN]` id referenced in `text`, in order of first appearance, deduplicated. */
export function citedIds(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(MARKER_RE)) {
    const id = `e${m[1]}`;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Remove every `[eN]` marker whose id is not in `validIds`, and report how many were removed.
 *
 * `validIds` is every id the ledger actually minted — the ones the model was shown — not just
 * the ones a caller expects to be cited. A marker for an id outside that set can only be the
 * model inventing a citation (a hallucinated source, or a stale id from earlier in a very long
 * answer), and it is stripped rather than left to render as a dead link.
 */
export function stripUnresolvedMarkers(
  text: string,
  validIds: ReadonlySet<string>
): { text: string; strippedCount: number } {
  let strippedCount = 0;
  const out = text.replace(MARKER_RE, (whole, num: string) => {
    const id = `e${num}`;
    if (validIds.has(id)) return whole;
    strippedCount += 1;
    return "";
  });
  return { text: out, strippedCount };
}
