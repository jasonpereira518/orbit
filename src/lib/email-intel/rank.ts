/**
 * Ranking the people in a user's network for one email event.
 *
 * Gathers candidates from three places, loads what scoring needs in batched reads, and scores
 * in JavaScript (`scoreEmailContact`). Not SQL: the weights change as this is tuned, and a
 * scoring expression spread across a query cannot be read, tested or explained.
 *
 * Nothing is stored. A ranking computed from the network as it is now cannot go stale, and P4
 * calls it when it builds Radar's list.
 *
 *  1. People on the thread: the ones the model named plus every address on the thread's
 *     headers, resolved through `contact_identities` (so a merge, a deletion or a contact
 *     added later is always reflected).
 *  2. Contacts at the event's company, matched on the same normalised key the events feature
 *     uses, with corporate suffixes stripped so "Stripe" finds "Stripe, Inc.".
 *  3. A lexical search of profiles on the role's words. `embedding: null` skips the semantic
 *     arm: no embedding call, no AI cost, safe to run for every event in a background pass.
 *
 * Every read is scoped to the user. Candidate rows never select notes, avatars or other prose.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { emailThreads } from "@/db/schema";
import { goalRelevanceComponent } from "@/lib/closeness";
import { loadTargetKeys } from "@/lib/events/companies";
import { companyMatchKeys } from "@/lib/events/company-list-parse";
import type { RelevanceReason } from "@/lib/events/relevance";
import { hybridSearchContacts } from "@/lib/hybrid-search";
import { listActiveGoalTextsForUser } from "@/lib/user-goals";
import { resolveEmails } from "./resolve";
import { scoreEmailContact, significantWords, type EmailRelevanceBucket } from "./relevance";
import type { EmailEventKind, EmailEventPerson } from "./types";

/** Contacts pulled in because they work at the event's company. */
const COMPANY_CANDIDATES = 60;
/** Contacts pulled in because their profile matches the role. */
const SEARCH_CANDIDATES = 20;
export const DEFAULT_RANK_LIMIT = 3;

export type RankContext = { goals: string[]; targetKeys: Map<string, number> };

export type RankableEvent = {
  kind: Exclude<EmailEventKind, "other">;
  company: string | null;
  role: string | null;
  people: EmailEventPerson[];
  threadRowId: string | null;
};

export type RankedEventContact = {
  contactId: string;
  fullName: string;
  company: string | null;
  title: string | null;
  score: number;
  bucket: EmailRelevanceBucket;
  reasons: RelevanceReason[];
  via: Array<"thread" | "company" | "search">;
};

/** The user's goals and target companies: two reads, shared by every event in a pass. */
export async function loadRankContext(userId: string): Promise<RankContext> {
  const [goals, targetKeys] = await Promise.all([listActiveGoalTextsForUser(userId), loadTargetKeys(userId)]);
  return { goals, targetKeys };
}

/** The addresses on a thread's headers (P1 stored them, the user's own excluded). */
async function threadParticipants(userId: string, threadRowId: string | null): Promise<string[]> {
  if (!threadRowId) return [];
  const db = await getDb();
  const [row] = await db
    .select({ participants: emailThreads.participants })
    .from(emailThreads)
    .where(and(eq(emailThreads.id, threadRowId), eq(emailThreads.userId, userId)));
  return row?.participants ?? [];
}

const NORMALIZED_COMPANY =
  "trim(regexp_replace(regexp_replace(lower(company), '[^a-z0-9\\s]', ' ', 'g'), '\\s+', ' ', 'g'))";
const WITHOUT_SUFFIX = `regexp_replace(${NORMALIZED_COMPANY}, '\\s+(inc|llc|ltd|limited|corp|corporation|co|company|gmbh|sa|nv|bv|plc|pbc|llp|lp)$', '')`;

/** Ids of contacts whose employer matches any of these keys, closest and most recent first. */
async function contactsAtCompany(userId: string, keys: string[], limit: number): Promise<string[]> {
  const unique = [...new Set(keys.filter(Boolean))];
  if (unique.length === 0) return [];
  const db = await getDb();
  const list = sql.join(unique.map((key) => sql`${key}`), sql`, `);
  return rowsOf<{ id: string }>(
    await db.execute(sql`
      SELECT id
        FROM contacts
       WHERE user_id = ${userId}
         AND company IS NOT NULL
         AND (${sql.raw(NORMALIZED_COMPANY)} IN (${list}) OR ${sql.raw(WITHOUT_SUFFIX)} IN (${list}))
       ORDER BY CASE closeness_tier WHEN 'inner' THEN 0 WHEN 'mid' THEN 1 ELSE 2 END,
                last_interaction_at DESC NULLS LAST,
                id
       LIMIT ${limit}
    `)
  ).map((r) => r.id);
}

type CandidateRow = {
  id: string;
  full_name: string;
  company: string | null;
  title: string | null;
  industry: string | null;
  closeness_tier: "inner" | "mid" | "outer" | null;
};

async function loadCandidateRows(userId: string, ids: string[]): Promise<CandidateRow[]> {
  const db = await getDb();
  return rowsOf<CandidateRow>(
    await db.execute(sql`
      SELECT id, full_name, company, title, industry, closeness_tier
        FROM contacts
       WHERE user_id = ${userId}
         AND id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
    `)
  );
}

type Via = { thread: boolean; company: boolean; search: boolean; searchRelevance: number };

export async function rankEventContacts(
  userId: string,
  event: RankableEvent,
  opts: { limit?: number; context?: RankContext } = {}
): Promise<RankedEventContact[]> {
  const limit = opts.limit ?? DEFAULT_RANK_LIMIT;
  const companyKeys = companyMatchKeys(event.company);
  const roleWords = significantWords(event.role);

  const context = opts.context ?? (await loadRankContext(userId));
  const headerEmails = await threadParticipants(userId, event.threadRowId);
  const [threadOwners, companyIds, searched] = await Promise.all([
    resolveEmails(userId, [...event.people.map((p) => p.email ?? ""), ...headerEmails]),
    contactsAtCompany(userId, companyKeys, COMPANY_CANDIDATES),
    roleWords.length > 0
      ? hybridSearchContacts(userId, { query: roleWords.join(" "), embedding: null, limit: SEARCH_CANDIDATES, withProse: false })
      : Promise.resolve([]),
  ]);

  const via = new Map<string, Via>();
  const touch = (id: string): Via => {
    let v = via.get(id);
    if (!v) via.set(id, (v = { thread: false, company: false, search: false, searchRelevance: 0 }));
    return v;
  };
  for (const id of threadOwners.values()) touch(id).thread = true;
  for (const id of companyIds) touch(id).company = true;
  for (const hit of searched) {
    const v = touch(hit.id);
    v.search = true;
    v.searchRelevance = Math.max(v.searchRelevance, hit.relevance);
  }
  if (via.size === 0) return [];

  const rows = await loadCandidateRows(userId, [...via.keys()]);
  const eventCompanyKeys = companyKeys;
  const ranked: RankedEventContact[] = [];
  for (const row of rows) {
    const v = via.get(row.id)!;
    const result = scoreEmailContact({
      eventKind: event.kind,
      eventCompany: event.company,
      eventCompanyKeys,
      eventRole: event.role,
      candidate: {
        contactId: row.id,
        fullName: row.full_name,
        company: row.company,
        title: row.title,
        companyKeys: companyMatchKeys(row.company),
        closenessTier: row.closeness_tier,
      },
      via: { thread: v.thread, search: v.search, searchRelevance: v.searchRelevance },
      targetKeys: context.targetKeys,
      goalFit: goalRelevanceComponent(
        { company: row.company, title: row.title, industry: row.industry } as Parameters<typeof goalRelevanceComponent>[0],
        context.goals
      ),
    });
    // A row with nothing to say about it is padding, and padding is what makes a
    // recommendation list ignorable.
    if (result.reasons.length === 0 || result.bucket === "skip") continue;
    ranked.push({
      contactId: row.id,
      fullName: row.full_name,
      company: row.company,
      title: row.title,
      score: result.score,
      bucket: result.bucket,
      reasons: result.reasons,
      via: [v.thread && "thread", v.company && "company", v.search && "search"].filter(
        (x): x is "thread" | "company" | "search" => Boolean(x)
      ),
    });
  }

  return ranked
    .sort((a, b) => b.score - a.score || a.fullName.localeCompare(b.fullName) || a.contactId.localeCompare(b.contactId))
    .slice(0, limit);
}
