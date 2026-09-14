import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import {
  MIN_ORG_NAME_LEN,
  normalizeQuestionForOrgs,
  questionMentionsOrg,
} from "@/lib/chat-roster-match";
import { canonicalCompanyClusterName } from "@/lib/company-family";
import { foldSchoolNames } from "@/lib/school-name";
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
// The name test and its stoplist live in `@/lib/chat-roster-match`: the composer's
// suggestion cards have to ask the same question before offering "Who else do I know at
// {company}?", and a second copy of the list would drift.

type OrgRow = { name: string; kind: "company" | "school"; total: number };

export async function findOrgRosters(
  userId: string,
  question: string
): Promise<OrgRoster[]> {
  const haystack = normalizeQuestionForOrgs(question);
  if (haystack.trim().length < MIN_ORG_NAME_LEN) return [];

  const db = await getDb();

  // Two grouped scans rather than one, because a contact belongs to their employer AND
  // their school. This was `coalesce(company, school)` with a `case` for the kind, which
  // counts anyone holding a job as a company row only — so a school's `total` excluded
  // every employed alum while the roster fetch below, keyed on `school` alone, listed them.
  // The block still printed "(complete)", over a number the system prompt calls
  // "authoritative and exhaustive". Two scans is the price of the count being true.
  const groupedBy = (
    column: typeof contacts.company | typeof contacts.school,
    kind: "company" | "school"
  ) =>
    db
      .select({
        name: sql<string>`${column}`,
        kind: sql<"company" | "school">`${kind}`,
        total: sql<number>`count(*)::int`,
      })
      .from(contacts)
      .where(and(eq(contacts.userId, userId), isNotNull(column)))
      .groupBy(column);

  const [companyRows, schoolRows] = await Promise.all([
    groupedBy(contacts.company, "company"),
    groupedBy(contacts.school, "school"),
  ]);
  const orgRows = [...companyRows, ...schoolRows];

  // Schools fold by acronym, derived from this user's own values — "MIT" and
  // "Massachusetts Institute of Technology" were two organisations with two counts, so a
  // question naming either saw half the alumni. Built before the loop because folding a
  // name needs to know every other name.
  const schoolFold = foldSchoolNames(
    orgRows.filter((r) => r.kind === "school").map((r) => (r.name || "").trim())
  );

  // Fold aliases together the same way the constellation does, so "AWS" and "Amazon Web
  // Services" are one organisation here too and the count matches what the map shows.
  const byCanonical = new Map<string, { kind: "company" | "school"; display: string; variants: Set<string>; total: number }>();
  for (const row of orgRows as OrgRow[]) {
    const raw = (row.name || "").trim();
    if (!raw) continue;
    const canonical =
      row.kind === "company"
        ? canonicalCompanyClusterName(raw) || raw
        : schoolFold.get(raw) || raw;
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
        questionMentionsOrg(haystack, entry.display) ||
        [...entry.variants].some((v) => questionMentionsOrg(haystack, v))
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
