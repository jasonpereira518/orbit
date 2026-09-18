/**
 * How well a contact's NAME answers a search, in one place for SQL (list and picker
 * ordering) and JS (hybrid search). No `@/db` import: schema and drizzle only.
 *
 * Tier 0: the query is the whole name or a whole word of it ("priya" in "Priya Raman").
 * Tier 1: a word of the name starts with it ("priya" in "Priyanka Das").
 * Tier 2: it matched somewhere else — company, tags, notes.
 */
import { sql, type SQL } from "drizzle-orm";
import { contacts } from "@/db/schema";

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function normalizeSearchQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

export function nameMatchTier(fullName: string, preferredName: string | null | undefined, query: string): 0 | 1 | 2 {
  const q = normalizeSearchQuery(query);
  if (!q) return 2;
  let tier: 0 | 1 | 2 = 2;
  for (const raw of [fullName, preferredName ?? ""]) {
    const n = raw.trim().toLowerCase();
    if (!n) continue;
    if (n === q || n.startsWith(`${q} `) || n.endsWith(` ${q}`) || n.includes(` ${q} `)) return 0;
    if (n.startsWith(q) || n.includes(` ${q}`)) tier = 1;
  }
  return tier;
}

/** The same tiers as a SQL expression. Must agree with `nameMatchTier` (the smoke checks). */
export function nameMatchTierSql(query: string): SQL<number> {
  const q = normalizeSearchQuery(query);
  const e = escapeLike(q);
  const name = sql`lower(btrim(${contacts.fullName}))`;
  const pref = sql`lower(btrim(coalesce(${contacts.preferredName}, '')))`;
  const whole = (col: SQL) =>
    sql`(${col} = ${q} or ${col} like ${`${e} %`} or ${col} like ${`% ${e}`} or ${col} like ${`% ${e} %`})`;
  const prefix = (col: SQL) => sql`(${col} like ${`${e}%`} or ${col} like ${`% ${e}%`})`;
  return sql<number>`(case when ${whole(name)} or ${whole(pref)} then 0 when ${prefix(name)} or ${prefix(pref)} then 1 else 2 end)`;
}

/**
 * Match a query against the stored search vector, fuzzily against names, and against tags.
 * Moved unchanged from `searchCondition` in src/actions/contacts.ts (a "use server" file
 * cannot export it), so the contacts list, the picker and the smoke share one condition.
 *
 * Four branches because they answer different questions. `search_tsv` is whole-word and
 * ranked, and covers everything on the contact row. The `%` prefix match is kept for the
 * partial-word case a user typing into a filter box expects. Trigram similarity finds a
 * name spelled one character off; it is index-backed via `contacts_name_trgm`, so it is
 * only added for queries long enough to produce meaningful trigrams. Tags live in their
 * own table, so they are an EXISTS. `search_tsv` is a bare identifier because Drizzle has
 * no tsvector column type; the query selects `from contacts` unaliased, so it resolves.
 */
export function contactSearchCondition(q: string) {
  const like = `${q.toLowerCase()}%`;
  const lowered = q.toLowerCase();
  const fuzzy =
    lowered.length >= 4
      ? sql` or lower(${contacts.fullName}) % ${lowered} or lower(coalesce(${contacts.company}, '')) % ${lowered}`
      : sql``;
  return sql`(
    contacts.search_tsv @@ websearch_to_tsquery('simple', ${q})
    or lower(${contacts.fullName}) like ${like}
    or lower(coalesce(${contacts.company}, '')) like ${like}
    or lower(coalesce(${contacts.email}, '')) like ${like}
    ${fuzzy}
    or exists (
      select 1 from contact_tags ct
      join tags t on t.id = ct.tag_id
      where ct.contact_id = ${contacts.id} and lower(t.name) like ${like}
    )
  )`;
}

export type NamePolicyRow = {
  fullName: string;
  preferredName: string | null;
  company: string | null;
  title: string | null;
  school: string | null;
  email: string | null;
  location: string | null;
  industry: string | null;
  tags: string[];
  keyFacts: string[];
  matchedArms: string[];
};

function wordStarts(text: string | null, q: string): boolean {
  return Boolean(text) && text!.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.startsWith(q));
}

/** The query appears nowhere on the row but the prose (notes, AI summary). */
function proseOnly(row: NamePolicyRow, q: string): boolean {
  if (row.matchedArms.includes("semantic") || row.matchedArms.includes("experience")) return false;
  const fields = [row.company, row.title, row.school, row.email, row.location, row.industry, ...row.tags, ...row.keyFacts];
  return !fields.some((f) => wordStarts(f, q));
}

/**
 * For a single-token query: name matches first (tier 0, then 1, each in fused order),
 * everything else after; and when at least one name matched, rows whose only evidence is
 * prose are dropped — a name lookup is not a notes search. With no name match nothing is
 * dropped, so "Durham" still finds whoever's notes say Durham. Multi-token queries pass
 * through unchanged.
 */
export function applyNameMatchPolicy<T extends NamePolicyRow>(rows: T[], query: string): T[] {
  const q = normalizeSearchQuery(query);
  if (!q || q.includes(" ")) return rows;
  const tiered = rows.map((row, i) => ({ row, i, tier: nameMatchTier(row.fullName, row.preferredName, q) }));
  const anyName = tiered.some((t) => t.tier < 2);
  return tiered
    .filter((t) => !anyName || t.tier < 2 || !proseOnly(t.row, q))
    .sort((a, b) => a.tier - b.tier || a.i - b.i)
    .map((t) => t.row);
}
