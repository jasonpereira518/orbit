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
};

export type KnowledgeBasePayload = {
  stats: KnowledgeStats;
  entries: KnowledgeEntry[];
};
