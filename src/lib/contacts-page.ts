/**
 * Shared types and constants for the paginated contacts list.
 *
 * Kept out of `src/actions/contacts.ts` because that file is `"use server"`, and a server
 * actions file may only export async functions — a plain `const` there is a build error.
 * Both the server action and the client list component import from here.
 */

/**
 * How a contacts page is ordered. The cursor's shape follows from this, so a page fetched
 * under one sort cannot be continued under another.
 */
export type ContactSort = "name" | "closeness" | "recent";

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
  relationshipScore: number;
  /** 0–1, matching what the UI renders. Stored as a 0–100 integer so it can be indexed. */
  closeness: number;
  closenessTier: "inner" | "mid" | "outer";
  priorityLevel: number;
  nextFollowUpAt: Date | null;
  lastInteractionAt: Date | null;
  tags: string[];
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
};
