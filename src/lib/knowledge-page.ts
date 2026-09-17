/**
 * Shared types and constants for the knowledge base.
 *
 * Kept out of `src/actions/knowledge.ts` for the same reason `contacts-page.ts` exists: that
 * file is `"use server"`, and a server-actions module may only export async functions. A
 * plain `const` there is not a lint warning — it strips every export from the module, and
 * the page importing it fails to build with "the module has no exports at all".
 */

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
   * Every entry the knowledge base could show, across all five kinds.
   *
   * Separate from the counts above because none of them is that number: summing messages,
   * notes and meetings omits summaries and key facts, which is how the page came to render
   * "Showing 94 of 64 items". The list is capped, so the honest denominator has to be
   * counted rather than derived.
   */
  entriesTotal: number;
};

export type KnowledgeBasePayload = {
  stats: KnowledgeStats;
  entries: KnowledgeEntry[];
};

export type KnowledgeQuery = {
  q?: string;
  kind?: KnowledgeKind | "all";
};

/** How many entries one page of the knowledge base returns. */
export const KNOWLEDGE_PAGE_SIZE = 300;
