/**
 * Where an interaction came from, where it changes how it counts. DB-free (schema only).
 *
 * `ai_derived` marks rows a model inferred rather than a person logged or a provider
 * recorded — today the LinkedIn timeline events. They summarise messages that are already
 * rows of their own, so counting them double-counts the thread, and a meeting a model read
 * into a message is not evidence a meeting happened. They stay on the timeline; they are
 * excluded from recency, closeness and "last touch".
 */
import { isNull, ne, or, type SQL } from "drizzle-orm";
import { interactions } from "@/db/schema";

export const AI_DERIVED_SOURCE = "ai_derived";

/** WHERE fragment: the row is a real touch (anything but an AI-derived event). */
export function countsAsTouch(): SQL {
  return or(isNull(interactions.source), ne(interactions.source, AI_DERIVED_SOURCE))!;
}

/** Row-level `countsAsTouch`, for interactions already loaded. */
export function isLoggedTouch(row: { source: string | null }): boolean {
  return row.source !== AI_DERIVED_SOURCE;
}

/** The newest real touch from rows ordered newest first, or null. */
export function latestLoggedTouch<T extends { source: string | null }>(newestFirst: readonly T[]): T | null {
  return newestFirst.find(isLoggedTouch) ?? null;
}
