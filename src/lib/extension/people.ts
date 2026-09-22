/**
 * Pages about more than one person: pick lists and organizations.
 *
 * `resolveBatch` answers "who on this list do I know?" for up to ten people in
 * two statements, so a LinkedIn search-results page costs one request, not ten.
 * Its one rule worth defending: a NAME is never enough to say "known". Two
 * people share a name all the time, and a list row that confidently says you
 * know someone you don't is worse than one that says "maybe".
 *
 * `lookupCompany` answers "who do I know at this organization?" — people whose
 * contact record says they work there now, and people whose work history says
 * they did. The org key is `normalizeCompanyKey`, which is how work history is
 * stored, so this agrees with the contact pages.
 */
import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { contactExperiences, contacts } from "@/db/schema";
import { normalizeCompanyKey } from "@/lib/company-name";
import { findIdentityOwners } from "@/lib/contact-identity";
import { identityKeysFor, normalizeXHandle, type IdentityKey } from "@/lib/duplicates";
import type {
  CompanyLookupResponse,
  CompanyPerson,
  PageCandidate,
  PageOrg,
  ResolveBatchItem,
} from "./contract";
import { githubLogin } from "./github";
import { SEARCH_RESULT_COLUMNS } from "./search";

/* -------------------------------------------------------------------------- */
/* Batch resolve                                                              */
/* -------------------------------------------------------------------------- */

function hostOf(url: string | undefined) {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** The exact identities a list row carries — never its name. */
function keysFor(candidate: PageCandidate): { identity: IdentityKey[]; github: string } {
  const host = hostOf(candidate.profileUrl);
  const onLinkedIn = host === "linkedin.com" || host.endsWith(".linkedin.com");
  const onX = /^((www|mobile)\.)?(x|twitter)\.com$/.test(host);
  const onGithub = host === "github.com" || host === "www.github.com";
  return {
    identity: identityKeysFor({
      linkedinUrl: onLinkedIn ? candidate.profileUrl : null,
      xHandle: onX ? normalizeXHandle(candidate.profileUrl) : null,
      email: candidate.email ?? null,
    }),
    github: onGithub ? githubLogin(candidate.profileUrl) : "",
  };
}

const keyId = (key: IdentityKey) => `${key.kind}:${key.value}`;

export async function resolveBatch(
  userId: string,
  candidates: PageCandidate[]
): Promise<ResolveBatchItem[]> {
  const perCandidate = candidates.map(keysFor);
  const allKeys = perCandidate.flatMap((k) => k.identity);
  const owners = await findIdentityOwners(userId, allKeys);
  const ownersByKey = new Map<string, Set<string>>();
  for (const owner of owners) {
    const id = keyId(owner.key);
    if (!ownersByKey.has(id)) ownersByKey.set(id, new Set());
    ownersByKey.get(id)!.add(owner.contactId);
  }

  const ownerIds = [...new Set(owners.map((o) => o.contactId))];
  const names = [...new Set(candidates.map((c) => c.name.trim().toLowerCase()).filter(Boolean))];
  const logins = [...new Set(perCandidate.map((k) => k.github).filter(Boolean))];

  const db = await getDb();
  const clauses = [];
  if (ownerIds.length) clauses.push(inArray(contacts.id, ownerIds));
  if (names.length) clauses.push(inArray(sql`lower(${contacts.fullName})`, names));
  for (const login of logins) {
    clauses.push(sql`lower(${contacts.website}) like ${`%github.com/${login}`}`);
    clauses.push(sql`lower(${contacts.website}) like ${`%github.com/${login}/%`}`);
  }
  const rows = clauses.length
    ? await db
        .select({ ...SEARCH_RESULT_COLUMNS, website: contacts.website })
        .from(contacts)
        .where(and(eq(contacts.userId, userId), or(...clauses)))
        .limit(200)
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const strip = (row: (typeof rows)[number]) => ({
    id: row.id,
    fullName: row.fullName,
    company: row.company,
    title: row.title,
    photoUrl: row.photoUrl,
  });

  return candidates.map((candidate, index) => {
    const { identity, github } = perCandidate[index];
    const exact = new Set<string>();
    for (const key of identity) {
      for (const id of ownersByKey.get(keyId(key)) ?? []) exact.add(id);
    }
    if (github) {
      for (const row of rows) if (githubLogin(row.website) === github) exact.add(row.id);
    }
    if (exact.size === 1) {
      const row = byId.get([...exact][0]);
      if (row) return { index, status: "known", contact: strip(row) };
    }
    if (exact.size > 1) {
      // Two contacts claim one profile: a real duplicate, never silently one.
      const row = byId.get([...exact][0]);
      return { index, status: "possible", contact: row ? strip(row) : null };
    }
    const name = candidate.name.trim().toLowerCase();
    const byName = rows.find((row) => row.fullName.trim().toLowerCase() === name);
    return byName
      ? { index, status: "possible", contact: strip(byName) }
      : { index, status: "new", contact: null };
  });
}

/* -------------------------------------------------------------------------- */
/* Company lookup                                                             */
/* -------------------------------------------------------------------------- */

const LEGAL_WORDS = "inc|llc|ltd|limited|gmbh|corp|corporation|co|plc|sa|ag|bv|pbc";
const PEOPLE_LIMIT = 10;

/**
 * The key two organization names are the same company on: the app's
 * `normalizeCompanyKey` (how work history is stored) with trailing legal
 * suffixes dropped, so "Stripe, Inc.", "stripe" and "Stripe Inc" all key to
 * "stripe". A name that IS a suffix word ("Co") keeps it — only a suffix after
 * a space is dropped.
 */
export function companyKey(name: string): string {
  return normalizeCompanyKey(name)
    .replace(new RegExp(`(?:\\s+(?:${LEGAL_WORDS}))+$`), "")
    .trim();
}

const dropLegalSuffix = (expr: SQL) =>
  sql`btrim(regexp_replace(${expr}, ${`([[:space:]]+(${LEGAL_WORDS}))+$`}, ''))`;

/**
 * `companyKey`, in SQL, over a stored `contacts.company`: lower, anything not a
 * letter/digit/space to a space, runs of space collapsed, trimmed — exactly
 * `normalizeCompanyKey` — then the suffix drop. `smoke-extension-people` holds
 * this and the JS version in agreement on the names that matter.
 */
export const companyKeySql = (value: SQL) =>
  dropLegalSuffix(
    sql`btrim(regexp_replace(regexp_replace(lower(coalesce(${value}, '')), '[^a-z0-9[:space:]]', ' ', 'g'), '[[:space:]]+', ' ', 'g'))`
  );

export async function lookupCompany(
  userId: string,
  org: PageOrg,
  options: { includePeople: boolean }
): Promise<CompanyLookupResponse> {
  const key = companyKey(org.name);
  if (!key) return { currentTotal: 0, formerTotal: 0, people: [], locked: !options.includePeople };

  const db = await getDb();
  const worksThere = sql`${companyKeySql(sql`${contacts.company}`)} = ${key}`;

  // People whose history names this org. Work history is stored already
  // normalized, so only the suffix drop is needed. Tenant-scoped inside the
  // subquery, not only outside it.
  const pastRoles = db
    .select({ id: contactExperiences.contactId })
    .from(contactExperiences)
    .where(
      and(
        eq(contactExperiences.userId, userId),
        eq(contactExperiences.kind, "role"),
        eq(contactExperiences.isCurrent, false),
        sql`${dropLegalSuffix(sql`${contactExperiences.organizationNormalized}`)} = ${key}`
      )
    );

  const total = sql<number>`count(*) over ()`.mapWith(Number);
  const [current, former] = await Promise.all([
    db
      .select({ ...SEARCH_RESULT_COLUMNS, total })
      .from(contacts)
      .where(and(eq(contacts.userId, userId), worksThere))
      .orderBy(sql`${contacts.lastInteractionAt} desc nulls last`, desc(contacts.updatedAt))
      .limit(PEOPLE_LIMIT),
    db
      .select({ ...SEARCH_RESULT_COLUMNS, total })
      .from(contacts)
      .where(
        and(
          eq(contacts.userId, userId),
          inArray(contacts.id, pastRoles),
          // Someone who is there now is "current", not also "former".
          sql`not (${worksThere})`
        )
      )
      .orderBy(sql`${contacts.lastInteractionAt} desc nulls last`, desc(contacts.updatedAt))
      .limit(PEOPLE_LIMIT),
  ]);

  const person = (relation: CompanyPerson["relation"]) => (row: (typeof current)[number]): CompanyPerson => ({
    id: row.id,
    fullName: row.fullName,
    company: row.company,
    title: row.title,
    photoUrl: row.photoUrl,
    relation,
  });

  return {
    currentTotal: current[0]?.total ?? 0,
    formerTotal: former[0]?.total ?? 0,
    // The counts are the free teaser; the names are Pro.
    people: options.includePeople
      ? [...current.map(person("current")), ...former.map(person("former"))].slice(0, PEOPLE_LIMIT)
      : [],
    locked: !options.includePeople,
  };
}

