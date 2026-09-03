import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { canonicalCompanyClusterName } from "@/lib/company-family";
import { normalizeCompanyName } from "@/lib/company-name";

/**
 * Exact, complete answer to "who do I know at <org>?".
 *
 * Chat retrieval is a relevance-ranked top-K (12). That is right for open questions and
 * wrong for the single most-asked one: with 24 people at AWS in the network, the model
 * sees at most 12 of them and answers "you know four people at AWS". The count is the
 * whole point of the question, so it cannot come out of a truncated list.
 *
 * This resolves the organisation named in the question against the network's own
 * company/school names, then hands the model the full roster and an authoritative total.
 * Nothing here is generated — it is a group-by.
 */
export type OrgRoster = {
  kind: "company" | "school";
  /** The organisation as the user's own data spells it. */
  name: string;
  /** Everyone at the org, before the listing cap. */
  total: number;
  people: Array<{ id: string; name: string; title: string | null }>;
  truncated: boolean;
};

/** Listing cap. The `total` is still exact when this truncates. */
const ROSTER_PEOPLE_CAP = 50;
/** At most this many organisations per question, so a rambling question can't blow the prompt. */
const MAX_ROSTERS = 2;
/**
 * Names shorter than this are not matched: a two-letter company would fire on almost any
 * question, and the false positives are worse than the miss.
 */
const MIN_ORG_NAME_LEN = 3;

/** Everyday words that also happen to be company names; matching them is nearly always wrong. */
const STOPLIST = new Set([
  "the", "and", "for", "you", "who", "how", "new", "one", "next", "now", "all",
  "get", "app", "inc", "llc", "self", "self employed", "freelance", "student",
  "none", "n/a", "unknown", "independent",
]);

function normalizeQuestion(question: string) {
  // Punctuation to spaces so "at Google?" and "Google's" both match "google", and pad the
  // ends so a whole-word test can be a plain substring test.
  return ` ${question.toLowerCase().replace(/[^a-z0-9+&. ]+/g, " ").replace(/\s+/g, " ").trim()} `;
}

function mentions(haystack: string, name: string) {
  const needle = normalizeCompanyName(name).replace(/[^a-z0-9+&. ]+/g, " ").replace(/\s+/g, " ").trim();
  if (needle.length < MIN_ORG_NAME_LEN || STOPLIST.has(needle)) return false;
  return haystack.includes(` ${needle} `);
}

type OrgRow = { name: string; kind: "company" | "school"; total: number };

export async function findOrgRosters(
  userId: string,
  question: string
): Promise<OrgRoster[]> {
  const haystack = normalizeQuestion(question);
  if (haystack.trim().length < MIN_ORG_NAME_LEN) return [];

  const db = await getDb();

  // Cheap: one grouped scan over two indexed-ish columns, no joins, no row bodies.
  const orgRows = await db
    .select({
      name: sql<string>`coalesce(${contacts.company}, ${contacts.school})`,
      kind: sql<"company" | "school">`case when ${contacts.company} is not null then 'company' else 'school' end`,
      total: sql<number>`count(*)::int`,
    })
    .from(contacts)
    .where(
      and(
        eq(contacts.userId, userId),
        sql`(${contacts.company} is not null or ${contacts.school} is not null)`
      )
    )
    .groupBy(
      sql`coalesce(${contacts.company}, ${contacts.school})`,
      sql`case when ${contacts.company} is not null then 'company' else 'school' end`
    );

  // Fold aliases together the same way the constellation does, so "AWS" and "Amazon Web
  // Services" are one organisation here too and the count matches what the map shows.
  const byCanonical = new Map<string, { kind: "company" | "school"; display: string; variants: Set<string>; total: number }>();
  for (const row of orgRows as OrgRow[]) {
    const raw = (row.name || "").trim();
    if (!raw) continue;
    const canonical = row.kind === "company" ? canonicalCompanyClusterName(raw) || raw : raw;
    const key = `${row.kind}:${normalizeCompanyName(canonical)}`;
    const entry = byCanonical.get(key) ?? {
      kind: row.kind,
      display: canonical,
      variants: new Set<string>(),
      total: 0,
    };
    entry.variants.add(raw);
    entry.total += Number(row.total) || 0;
    byCanonical.set(key, entry);
  }

  const matched = [...byCanonical.values()]
    .filter(
      (entry) =>
        mentions(haystack, entry.display) ||
        [...entry.variants].some((v) => mentions(haystack, v))
    )
    // Longest name first: "Google DeepMind" should win over "Google" when both match.
    .sort((a, b) => b.display.length - a.display.length)
    .slice(0, MAX_ROSTERS);

  if (matched.length === 0) return [];

  const rosters: OrgRoster[] = [];
  for (const entry of matched) {
    const variants = [...entry.variants];
    const rows = await db.query.contacts.findMany({
      where: and(
        eq(contacts.userId, userId),
        entry.kind === "company"
          ? inArray(contacts.company, variants)
          : inArray(contacts.school, variants),
        entry.kind === "company" ? isNotNull(contacts.company) : isNotNull(contacts.school)
      ),
      columns: {
        id: true,
        fullName: true,
        preferredName: true,
        title: true,
        closeness: true,
      },
      orderBy: (c, { desc }) => [desc(c.closeness)],
      limit: ROSTER_PEOPLE_CAP,
    });

    rosters.push({
      kind: entry.kind,
      name: entry.display,
      total: entry.total,
      people: rows.map((r) => ({
        id: r.id,
        name: r.preferredName || r.fullName,
        title: r.title,
      })),
      truncated: entry.total > rows.length,
    });
  }

  return rosters;
}
