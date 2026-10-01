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
import { sanitizeProfileLine } from "@/lib/contact-profile-format";

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
    }
  | {
      kind: "email_event";
      /** `email_events.id`: what the user's mail meant, as the email-insights feature derived it. */
      sourceId: string;
      contactId: string | null;
      /** ISO day of the email. */
      date: string | null;
    };

function keyOf(source: EvidenceSource): string {
  if (source.kind === "interaction") return `interaction:${source.sourceId}`;
  if (source.kind === "email_event") return `email_event:${source.sourceId}`;
  return `contact:${source.contactId}`;
}

/**
 * One `search_notes` result, as the answer prompt sees it. Each is a single dated source, so
 * each can carry its own `[eN]` marker, unlike the rest of what the research step looked up.
 * `kind` is absent on a passage of the user's own notes (an interaction), which is how every
 * caller built one before mail was searchable.
 */
export type NotePassage = {
  kind?: "interaction" | "email_event";
  sourceId: string;
  contactId: string | null;
  date: string | null;
  snippet: string;
};

/**
 * The passages as lines of the answer prompt, minting each one's citation id.
 *
 * A note reads `[eN] 2026-03-02: ...` exactly as it always has. A passage derived from the
 * user's mail says so (`, from your email:`), because it is the user's own summary of what
 * someone else wrote, and an answer that quotes it should not present it as something the
 * user wrote down themselves. The block these lines sit in is fenced as untrusted data by the
 * caller either way.
 */
export function renderNotePassages(passages: readonly NotePassage[], ledger: EvidenceLedger): string[] {
  return passages.map((p) => {
    const id =
      p.kind === "email_event"
        ? ledger.mint({ kind: "email_event", sourceId: p.sourceId, contactId: p.contactId, date: p.date })
        : ledger.mint({ kind: "interaction", sourceId: p.sourceId, contactId: p.contactId, date: p.date });
    const label = `${p.date ?? "undated"}${p.kind === "email_event" ? ", from your email" : ""}`;
    return `- [${id}] ${label}: ${sanitizeProfileLine(p.snippet)}`;
  });
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
