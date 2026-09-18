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
 *
 * `"relevance"` is the odd one out: it only means something alongside a search query, has
 * no stable keyset (a hybrid-search rank isn't a column), and so never paginates past its
 * first page. See `orderFor` in `src/actions/contacts.ts`.
 */
export type ContactSort =
  | "name"
  | "closeness"
  | "recent"
  | "last_touch"
  | "relevance";

/**
 * The sorts offered in the UI, in the order they appear.
 *
 * `recent` and `last_touch` are not the same question and the labels have to say so.
 * `recent` orders by `updated_at`, which moves whenever ANY write touches the row — an
 * import, an enrichment pass, an avatar backfill. It answers "what changed lately".
 * `last_touch` orders by `last_interaction_at`, which only a logged interaction moves, and
 * answers "who have I actually spoken to". The second is what people mean when they ask
 * the first, so it is the one named plainly.
 */
export const CONTACT_SORTS: { value: ContactSort; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "closeness", label: "Closeness" },
  { value: "last_touch", label: "Last spoken" },
  { value: "recent", label: "Recently updated" },
];

/**
 * `relevance` is deliberately absent from the picker above and still valid here.
 *
 * It is what a SEARCH sorts by — the page selects it implicitly when `q` is set — and it
 * means nothing without one. Offering it as a fifth chip would let someone pick "relevance"
 * on an empty query and get an ordering with no ranking behind it.
 */
export function isContactSort(value: unknown): value is ContactSort {
  return (
    value === "relevance" || CONTACT_SORTS.some((s) => s.value === value)
  );
}

/**
 * "Gone quiet" thresholds, in days since the last logged interaction.
 *
 * Deliberately offered as a few named intervals rather than a free number field: the
 * question a user is asking here is "who am I losing touch with", and they do not have a
 * 47-day opinion about it.
 */
export const QUIET_OPTIONS = [
  { value: 30, label: "30+ days" },
  { value: 90, label: "90+ days" },
  { value: 180, label: "180+ days" },
] as const;

/**
 * Parse the `quiet` query parameter into a threshold, or null for "not filtering".
 *
 * Anything unusable collapses to null rather than throwing — this arrives from a URL a user
 * can type. Clamped to the offered range because an unbounded value from a hand-edited URL
 * would either match everyone (0) or nobody (99999) while the chip still claimed to be
 * filtering.
 */
export function parseQuietDays(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const days = Math.round(n);
  const allowed = QUIET_OPTIONS.map((o) => o.value as number);
  return allowed.includes(days) ? days : null;
}

export const CONTACTS_PAGE_SIZE = 50;

export type ContactsPageFilters = {
  q?: string;
  company?: string;
  minScore?: number;
  followUp?: "due";
  /**
   * Only contacts whose last logged interaction is at least this many days old. Contacts
   * with no interaction at all are included: "never" is quieter than any threshold.
   */
  quiet?: number;
  sort?: ContactSort;
  /** Jump the A–Z rail to a letter. "#" means everything sorting before "a". */
  letter?: string;
  /** Restrict to contacts carrying this tag, matched case-insensitively. */
  tag?: string;
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
  /** True when the avatar route has a LinkedIn URL or email it could still resolve from. */
  canResolveAvatar: boolean;
  relationshipScore: number;
  /** 0–1, matching what the UI renders. Stored as a 0–100 integer so it can be indexed. */
  closeness: number;
  closenessTier: "inner" | "mid" | "outer";
  priorityLevel: number;
  nextFollowUpAt: Date | null;
  lastInteractionAt: Date | null;
  tags: string[];
  /** Why this contact matched an active search, only when that isn't obvious from the row
   *  itself (e.g. a past role, not their current company field). Null outside a search, and
   *  for the common case where the match is already visible in the row's own text. */
  matchReason: string | null;
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
