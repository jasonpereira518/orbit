/**
 * Shared types and constants for the paginated contacts list.
 *
 * Kept out of `src/actions/contacts.ts` because that file is `"use server"`, and a server
 * actions file may only export async functions — a plain `const` there is a build error.
 * Both the server action and the client list component import from here.
 *
 * Deliberately types and constants ONLY — no drizzle, no `@/db`. `ContactsList` (a client
 * component) imports `CONTACTS_PAGE_SIZE` from this file, so anything with a real runtime
 * import of `@/db` living here gets pulled into the browser bundle too: Next.js fails the
 * build with an unhelpful `node:fs` chunk error (`@electric-sql/pglite` reaches for
 * `node:fs`). The actual query — `listContactsPage`, which takes `userId` explicitly so it
 * is unit-testable outside a request — lives in `contacts-page-query.ts`, a server-only
 * sibling nothing client-side imports.
 */

export type ContactSort = "name" | "closeness" | "recent" | "relevance";

export const CONTACTS_PAGE_SIZE = 50;

export type ContactsPageFilters = {
  q?: string;
  company?: string;
  minScore?: number;
  followUp?: "due";
  sort?: ContactSort;
  /** Jump the A–Z rail to a letter. "#" means everything sorting before "a". */
  letter?: string;
  cursor?: string;
  limit?: number;
  /** Narrow the list to one import's people — the added and the matched-existing alike. */
  importId?: string;
};

export type ContactListRow = {
  id: string;
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  preferredName: string | null;
  title: string | null;
  company: string | null;
  school: string | null;
  location: string | null;
  linkedinUrl: string | null;
  profileImageUrl: string | null;
  /** True when the avatar route has a LinkedIn URL or email it could still resolve from. */
  canResolveAvatar: boolean;
  relationshipScore: number;
  /** 0–1, matching what the UI renders. Stored as a 0–100 integer so it can be indexed. */
  closeness: number;
  closenessTier: "inner" | "mid" | "outer";
  priorityLevel: number;
  nextFollowUpAt: Date | null;
  lastInteractionAt: Date | null;
  /** `contacts.source`; the list only reads it for the guided tour's "Example" chip. */
  source: string | null;
  tags: string[];
  /** Why this contact matched an active search, only when that isn't obvious from the row
   *  itself (e.g. a past role, not their current company field). Null outside a search, and
   *  for the common case where the match is already visible in the row's own text. */
  matchReason: string | null;
  /**
   * One of the people the import in `?importId=` added, so the list can mark them. False
   * without an import in the URL. The done card's "Meet your N new people" opens everyone,
   * with these N marked, rather than a list of only them.
   */
  fromImport: boolean;
};

export type ContactsPage = {
  items: ContactListRow[];
  nextCursor: string | null;
  /** Total matching the filters. Only computed for the first page; null when continuing. */
  total: number | null;
};

export type ContactPickerOption = {
  id: string;
  fullName: string;
  preferredName: string | null;
  company: string | null;
  /** For the gendered fallback illustration when there is no photo. */
  firstName: string | null;
  /**
   * Already browser-safe — `clientAvatarUrlSql` decides this in Postgres so a picker never
   * selects `profile_image_url`, which holds up to 120 KB of base64 per contact.
   */
  avatarUrl: string | null;
};
