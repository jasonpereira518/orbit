/**
 * What a merge archive (`contact_merges`) may hold and give back, and for how long.
 *
 * Pure constants, in a file of their own so `user-data.ts` (the purge) can share them
 * without importing `contact-merge.ts` and everything it pulls in.
 *
 * `privacy/probe-selective-deletion.ts` (S4) found that undoing a merge put back AI data the
 * person had deleted: the archive held full JSON copies of the loser's embeddings, Radar cards
 * and AI brief, no purge touched those copies, and unmerge re-inserted whatever it found.
 * Those rows are rebuildable — unmerge already schedules the embedding rebuild, briefs
 * regenerate on view, Radar re-ranks on its next run — so they are no longer archived at all,
 * and archives written before that are never restored from.
 */

/**
 * The only archived tables unmerge writes back: the person's own data, which cannot be
 * rebuilt (a tag they chose, a career move research found, a mention, a profile).
 */
export const RESTORABLE_ARCHIVE_TABLES = [
  "contact_tags",
  "contact_career_moves",
  "interaction_mentions",
  "contact_profiles",
] as const;

/** Derived tables that archives written before this change may still hold copies of. */
export const DERIVED_ARCHIVE_TABLES = ["contact_briefs", "recommendations", "contact_embeddings"] as const;

/**
 * How long a merge can be undone. After that the archive keeps only what makes the merged-away
 * id still resolve (`loser_contact_id` → `winner_contact_id`); the loser's snapshot and any
 * archived rows are cleared, so a merge does not keep a full copy of a person forever.
 */
export const MERGE_UNDO_DAYS = 30;

/** `status` of an archive whose undo window has passed and whose copies were cleared. */
export const MERGE_EXPIRED_STATUS = "expired";
