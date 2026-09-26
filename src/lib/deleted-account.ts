/**
 * The one word written into shared rows' creator columns when the creator's account is
 * purged — never null, never a dangling id — shared by recruiters and teams so the two
 * cannot drift.
 */
export const DELETED_ACCOUNT_SENTINEL = "deleted-account";
