/** DB-free: the /knowledge view and the loader share these. */
export type KnowledgeKind =
  | "message"
  | "note"
  | "summary"
  | "key_fact"
  | "meeting";

export type KnowledgeEntry = {
  id: string;
  kind: KnowledgeKind;
  contactId: string;
  contactName: string;
  company: string | null;
  title: string | null;
  snippet: string;
  date: string | null;
  source: string | null;
};

export type KnowledgeStats = {
  people: number;
  messages: number;
  notes: number;
  meetings: number;
  withSummary: number;
  withKeyFacts: number;
  embeddings: number;
  /**
   * Every entry the knowledge base could show, across all five kinds. Separate from the
   * counts above because none of them is that number — summing messages, notes and meetings
   * omits summaries and key facts, which rendered as "Showing 94 of 64 items".
   */
  entriesTotal: number;
};

export type KnowledgeBasePayload = {
  stats: KnowledgeStats;
  entries: KnowledgeEntry[];
};
