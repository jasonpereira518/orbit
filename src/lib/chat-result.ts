import type { ChatRecommendation } from "@/db/schema";
import type { RankedContact } from "@/lib/hybrid-search";

/**
 * The parts of a finished chat answer the UI reads after the stream ends (the
 * recommendation cards and the "people considered" list). Both chat surfaces build this from
 * the streaming route's final event. It used to be inferred from the `askNetwork` server
 * action's return type; that action had no callers left and was removed, so the shape lives
 * here.
 */
export type ChatResult = {
  recommendations: ChatRecommendation[];
  retrieved: Array<Pick<RankedContact, "id" | "fullName" | "company" | "title" | "relevance">>;
};
