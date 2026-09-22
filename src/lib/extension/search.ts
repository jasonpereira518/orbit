/**
 * Contact search for the extension: keyword on every plan, the app's ranked
 * search on Pro.
 *
 * Keyword search stays free because the free core needs it: "quick note about
 * anyone" needs a picker, and "link this page to someone stored under another
 * name" is what stops a `none` result being a dead end. Pro gets the ranking the
 * dashboard uses — full-text, typo tolerance, work history, and the semantic arm
 * for question-shaped queries.
 *
 * The ranked path can never cost the user their results: if it errors or runs
 * past `RANKED_BUDGET_MS`, the keyword answer is returned instead, marked
 * `mode: "keyword"` so the panel never claims a smarter search than it ran.
 */
import { and, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { rankContactsForQuery } from "@/lib/contact-ranking";
import type { ContactSearchResponse, ContactSearchResult } from "./contract";

export const SEARCH_LIMIT = 10;
const RANKED_BUDGET_MS = 2_500;

/**
 * Only an absolute https photo is useful to the extension: it is a different
 * origin (so `/api/avatars/{id}` would not resolve) and the wire contract
 * requires https. Decided in SQL so an inline row's base64 — up to 120 KB per
 * contact — never crosses the wire just to be dropped.
 */
const extensionPhotoUrl = sql<string | null>`CASE
  WHEN ${contacts.profileImageUrl} IS NULL
    OR btrim(${contacts.profileImageUrl}) = ''
    OR ${contacts.profileImageUrl} LIKE 'data:%'
    OR ${contacts.profileImageUrl} LIKE '%unavatar.io%'
    OR ${contacts.profileImageUrl} LIKE '%static.licdn.com/aero%'
    OR ${contacts.profileImageUrl} NOT LIKE 'https://%'
  THEN NULL
  ELSE btrim(${contacts.profileImageUrl})
END`;

export const SEARCH_RESULT_COLUMNS = {
  id: contacts.id,
  fullName: contacts.fullName,
  company: contacts.company,
  title: contacts.title,
  photoUrl: extensionPhotoUrl,
};

export async function keywordSearch(
  userId: string,
  q: string,
  limit = SEARCH_LIMIT
): Promise<ContactSearchResult[]> {
  const db = await getDb();
  const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  return db
    .select(SEARCH_RESULT_COLUMNS)
    .from(contacts)
    .where(
      and(
        eq(contacts.userId, userId),
        or(
          ilike(contacts.fullName, like),
          ilike(contacts.company, like),
          ilike(contacts.email, like)
        )
      )
    )
    .limit(limit);
}

async function rankedSearch(
  userId: string,
  q: string,
  limit = SEARCH_LIMIT
): Promise<ContactSearchResult[]> {
  const ranked = await rankContactsForQuery(userId, q, limit);
  if (ranked.length === 0) return [];
  const db = await getDb();
  const rows = await db
    .select(SEARCH_RESULT_COLUMNS)
    .from(contacts)
    .where(and(eq(contacts.userId, userId), inArray(contacts.id, ranked.map((r) => r.id))));
  const byId = new Map(rows.map((row) => [row.id, row]));
  // Keep the ranker's order; drop anything that vanished between the two reads.
  return ranked.flatMap((r) => byId.get(r.id) ?? []);
}

function withBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("ranked search over budget")), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export async function searchContactsForExtension(
  userId: string,
  q: string,
  options: {
    ranked: boolean;
    rankedBudgetMs?: number;
    /** Tests only: stand in for the ranker, to make its failure deterministic. */
    rank?: typeof rankedSearch;
  }
): Promise<ContactSearchResponse> {
  if (!q) return { results: [], mode: options.ranked ? "hybrid" : "keyword" };
  if (options.ranked) {
    try {
      const results = await withBudget(
        (options.rank ?? rankedSearch)(userId, q),
        options.rankedBudgetMs ?? RANKED_BUDGET_MS
      );
      return { results, mode: "hybrid" };
    } catch {
      // Fall through: slow or broken ranking must not cost the user results.
    }
  }
  return { results: await keywordSearch(userId, q), mode: "keyword" };
}
