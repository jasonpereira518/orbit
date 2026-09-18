/**
 * Keyset paging for the contacts list, moved out of src/actions/contacts.ts so it can be
 * exercised by `scripts/smoke-contacts-search-paging.ts`. DB-free.
 *
 * Every ordering ends in `id`, so it is a total order — without that tiebreak two contacts
 * comparing equal can straddle a page boundary and be shown twice or skipped. The tiebreak
 * runs in the same direction as the column ahead of it, because cursors are row-value
 * comparisons and that form compares every element the same way.
 *
 * During a search the name-match tier (`nameMatchTierSql`: 0 whole word, 1 prefix, 2
 * elsewhere) leads every sort, ascending, and the cursor carries the last row's tier as `t`.
 * The tier is compared on its own — `tier > t or (tier = t and <sort's row comparison>)` —
 * because it runs ascending while the closeness and recent sorts run descending.
 *
 * `relevance` (the default while searching) is one ranked page from hybrid search with no
 * keyset, so it never takes a cursor. The tier leads it as well: hybrid search already puts
 * name matches first among the rows it ranked, but a literal-only match it never produced
 * would otherwise fall below a prose-only row it did.
 */
import { asc, desc, sql, type SQL } from "drizzle-orm";
import { contacts } from "@/db/schema";
import type { ContactSort } from "@/lib/contacts-page";

export type ContactsCursor =
  | { s: "name"; k: string; n: string; id: string; t?: number }
  | { s: "closeness"; c: number; id: string; t?: number }
  | { s: "recent"; u: string; id: string; t?: number }
  // `lt`, not `t`: `t` is already the name-match tier on every variant, and a timestamp
  // stored under that key would be read back as a tier and compared against an integer.
  | { s: "last_touch"; lt: string | null; id: string; t?: number };

type CursorRow = {
  id: string;
  sortKey: string | null;
  fullName: string;
  closeness: number | null;
  updatedAt: Date;
  lastInteractionAt: Date | null;
  nameTier: number;
};

export function encodeContactsCursor(cursor: ContactsCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeContactsCursor(raw: string | undefined, sort: ContactSort, searching: boolean): ContactsCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    // A cursor from a different sort, or from a search when this is not one (or the other
    // way round), describes a position that does not exist in this ordering.
    if (!parsed || parsed.s !== sort) return null;
    if (searching !== (typeof parsed.t === "number")) return null;
    return parsed as ContactsCursor;
  } catch {
    return null;
  }
}

/**
 * Position within `rankedIds`, ascending so the best hybrid-search match (index 0) sorts
 * first; `array_position` returns null for a contact the ranking never produced, and null
 * sorts last under ascending order by default — hence the explicit `nulls last` rather than
 * relying on that default holding.
 */
function relevanceRank(rankedIds: readonly string[]): SQL {
  if (rankedIds.length === 0) return sql`0`;
  return sql`array_position(array[${sql.join(
    rankedIds.map((id) => sql`${id}::uuid`),
    sql`, `
  )}]::uuid[], ${contacts.id}) nulls last`;
}

export function contactsOrderBy(sort: ContactSort, tier: SQL<number> | null, rankedIds: readonly string[] = []): SQL[] {
  const lead = tier ? [asc(tier)] : [];
  // Rank, then name as the tiebreak — both for genuine ties and for rows the ranking can't
  // place at all.
  if (sort === "relevance") return [...lead, relevanceRank(rankedIds), asc(contacts.sortKey), asc(contacts.fullName), asc(contacts.id)];
  if (sort === "closeness") return [...lead, desc(contacts.closeness), desc(contacts.id)];
  if (sort === "recent") return [...lead, desc(contacts.updatedAt), desc(contacts.id)];
  // NULLS LAST, so people with no logged interaction sit at the bottom rather than the top:
  // Postgres puts NULLs FIRST under DESC by default, which would open the list with everyone
  // the user knows least about. It must match `contacts_user_last_touch_idx` exactly or the
  // index is not used and the sort becomes a full scan.
  if (sort === "last_touch") {
    return [...lead, sql`${contacts.lastInteractionAt} desc nulls last`, desc(contacts.id)];
  }
  return [...lead, asc(contacts.sortKey), asc(contacts.fullName), asc(contacts.id)];
}

function sortCondition(cursor: ContactsCursor): SQL {
  if (cursor.s === "closeness") {
    return sql`(${contacts.closeness}, ${contacts.id}) < (${cursor.c}, ${cursor.id}::uuid)`;
  }
  if (cursor.s === "recent") {
    return sql`(${contacts.updatedAt}, ${contacts.id}) < (${new Date(cursor.u)}, ${cursor.id}::uuid)`;
  }
  if (cursor.s === "last_touch") {
    // NULLS LAST has two phases, and a plain row-value comparison cannot express either:
    // `(col, id) < (NULL, x)` evaluates to NULL, which excludes every row, so one condition
    // here silently truncates the list at whatever page first reaches the undated tail.
    //
    // Phase one, still inside the dated rows: anything strictly older, plus every undated
    // row, since those all sort after the dated ones.
    if (cursor.lt !== null) {
      return sql`(
        (${contacts.lastInteractionAt}, ${contacts.id}) < (${new Date(cursor.lt)}, ${cursor.id}::uuid)
        or ${contacts.lastInteractionAt} is null
      )`;
    }
    // Phase two, already into the undated tail: only undated rows remain, ordered by id.
    return sql`(${contacts.lastInteractionAt} is null and ${contacts.id} < ${cursor.id}::uuid)`;
  }
  // Row-value comparison rather than an unrolled OR chain, so the planner can satisfy it
  // straight from `contacts_user_sort_idx`.
  return sql`(${contacts.sortKey}, ${contacts.fullName}, ${contacts.id}) > (${cursor.k}, ${cursor.n}, ${cursor.id}::uuid)`;
}

export function contactsCursorCondition(cursor: ContactsCursor, tier: SQL<number> | null): SQL {
  const within = sortCondition(cursor);
  if (!tier) return within;
  const t = cursor.t ?? 0;
  return sql`(${tier} > ${t}::int or (${tier} = ${t}::int and ${within}))`;
}

export function contactsCursorFor(sort: ContactSort, row: CursorRow, searching: boolean): ContactsCursor {
  const t = searching ? { t: Number(row.nameTier) } : {};
  if (sort === "closeness") return { s: "closeness", c: row.closeness ?? 0, id: row.id, ...t };
  if (sort === "recent") return { s: "recent", u: new Date(row.updatedAt).toISOString(), id: row.id, ...t };
  if (sort === "last_touch") {
    return {
      s: "last_touch",
      lt: row.lastInteractionAt ? new Date(row.lastInteractionAt).toISOString() : null,
      id: row.id,
      ...t,
    };
  }
  return { s: "name", k: row.sortKey ?? "", n: row.fullName, id: row.id, ...t };
}
