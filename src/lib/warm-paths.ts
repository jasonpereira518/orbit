import { normalizeCompanyKey } from "@/lib/company-name";

/**
 * Who you already know at a company — the question a job seeker most needs answered, and
 * the one Orbit could answer from day one and never did.
 *
 * ## Why this exists
 *
 * `contact_experiences` records every contact's current and past employers, normalised, with
 * an index on `(user_id, organization_normalized)`. That index exists for exactly one
 * question. Until now three files touched the table: the settings export, the profile
 * display, and the schema. Outreach drafted cold emails to strangers at companies where the
 * user already had a former colleague, and said nothing — because nothing anywhere
 * cross-referenced a target company against the network the user already had.
 *
 * ## Two sources, because one is not enough
 *
 * `contact_experiences` is only populated by profile capture and Apollo enrichment. The
 * overwhelmingly common case — a LinkedIn CSV import — writes `contacts.company` and no
 * experience rows at all. Ranking on the experiences table alone would therefore miss most
 * of a typical network, and ranking on `contacts.company` alone would miss every PAST
 * employer, which is where the "I used to work there" introductions come from. Both are
 * read, and the stronger reason wins per contact.
 *
 * Deliberately NOT here: matching on school. It needs the *prospect's* school to compare
 * against, which prospect search does not reliably return, so it would produce a connection
 * claim with nothing behind it.
 *
 * Pure: no database, no network. `findWarmPaths` in `warm-paths-server.ts` does the query
 * and hands rows here to be ranked.
 */

export type WarmPathReason =
  /** An experience row on this org, still current. */
  | "works_there"
  /** An experience row on this org that has ended. */
  | "worked_there"
  /** `contacts.company` resolves to this org — true today, but with no dates behind it. */
  | "listed_there";

/**
 * How much each reason is worth.
 *
 * A former colleague outranks a current one on purpose. Both can introduce you, but the
 * person who has LEFT can speak freely about the place, owes the employer nothing, and is
 * usually the more candid conversation — which is what someone deciding whether to apply
 * actually needs. `listed_there` sits last because a CSV company string carries no dates and
 * may be years stale.
 */
const REASON_WEIGHT: Record<WarmPathReason, number> = {
  worked_there: 100,
  works_there: 90,
  listed_there: 60,
};

export type WarmPathCandidate = {
  contactId: string;
  fullName: string;
  /** The normalised org key this row connects the contact to. */
  orgKey: string;
  /** The organisation as it should be shown — the contact's own spelling. */
  orgLabel: string;
  reason: WarmPathReason;
  title?: string | null;
  startYear?: number | null;
  endYear?: number | null;
  closeness?: number | null;
  relationshipScore?: number | null;
  profileImageUrl?: string | null;
  linkedinUrl?: string | null;
  email?: string | null;
};

export type WarmPath = {
  contactId: string;
  fullName: string;
  orgKey: string;
  orgLabel: string;
  reason: WarmPathReason;
  /** Ready to render: "worked there 2019-2022", "works there now". */
  reasonLabel: string;
  title: string | null;
  closeness: number | null;
  profileImageUrl: string | null;
  linkedinUrl: string | null;
  email: string | null;
};

/** How many connectors to keep per organisation. */
export const WARM_PATHS_PER_ORG = 5;

function reasonLabel(c: WarmPathCandidate): string {
  if (c.reason === "works_there") return "works there now";
  if (c.reason === "listed_there") return "listed there";
  // Dates are the whole value of a past role — "worked there" alone does not tell you
  // whether their knowledge is current. Degrade gracefully when they are missing, which
  // happens for experience rows captured without a date range.
  if (c.startYear && c.endYear) return `worked there ${c.startYear}-${c.endYear}`;
  if (c.endYear) return `worked there until ${c.endYear}`;
  if (c.startYear) return `worked there from ${c.startYear}`;
  return "worked there";
}

/**
 * Best connector first, within each organisation.
 *
 * Sorted by reason, then by closeness. Closeness rather than `relationshipScore` because the
 * former is the app's materialised judgement of the relationship and the latter is a raw
 * 1-5 that an import defaults to 2 for everyone — ranking a whole LinkedIn import by it
 * would be ranking by nothing. `relationshipScore` breaks remaining ties.
 */
export function rankWarmPaths(
  candidates: WarmPathCandidate[],
  perOrg: number = WARM_PATHS_PER_ORG
): Map<string, WarmPath[]> {
  // One contact can reach the same org through several rows — a current role and a past one,
  // or an experience row plus their `contacts.company`. Keep the strongest claim only, so a
  // person is never listed twice under one company.
  const strongest = new Map<string, WarmPathCandidate>();
  for (const c of candidates) {
    const key = `${c.orgKey}::${c.contactId}`;
    const held = strongest.get(key);
    if (!held || REASON_WEIGHT[c.reason] > REASON_WEIGHT[held.reason]) {
      strongest.set(key, c);
    }
  }

  const byOrg = new Map<string, WarmPathCandidate[]>();
  for (const c of strongest.values()) {
    const list = byOrg.get(c.orgKey) ?? [];
    list.push(c);
    byOrg.set(c.orgKey, list);
  }

  const out = new Map<string, WarmPath[]>();
  for (const [orgKey, list] of byOrg) {
    list.sort(
      (a, b) =>
        REASON_WEIGHT[b.reason] - REASON_WEIGHT[a.reason] ||
        (b.closeness ?? 0) - (a.closeness ?? 0) ||
        (b.relationshipScore ?? 0) - (a.relationshipScore ?? 0) ||
        a.fullName.localeCompare(b.fullName)
    );
    out.set(
      orgKey,
      list.slice(0, perOrg).map((c) => ({
        contactId: c.contactId,
        fullName: c.fullName,
        orgKey: c.orgKey,
        orgLabel: c.orgLabel,
        reason: c.reason,
        reasonLabel: reasonLabel(c),
        title: c.title ?? null,
        closeness: c.closeness ?? null,
        profileImageUrl: c.profileImageUrl ?? null,
        linkedinUrl: c.linkedinUrl ?? null,
        email: c.email ?? null,
      }))
    );
  }
  return out;
}

/**
 * The org keys to look up for a set of company names, deduped.
 *
 * Exported so callers normalise exactly the way the stored column was normalised — the
 * lookup is an equality match on `organization_normalized`, so a caller that lowercases by
 * hand instead would silently match nothing.
 */
export function orgKeysFor(names: (string | null | undefined)[]): string[] {
  const keys = new Set<string>();
  for (const name of names) {
    const key = normalizeCompanyKey(name?.trim() || "");
    if (key) keys.add(key);
  }
  return [...keys];
}
