import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { outreachEvidence, outreachProspects } from "@/db/schema";
import { UserFacingError } from "@/lib/errors";
import { getCampaignV2 } from "@/lib/outreach/campaigns";
import { getCreditBalance, releaseHold, reserveCredits } from "@/lib/outreach/credits/ledger";
import { parseFundingSource } from "@/lib/outreach/funding";
import { resolveResearchProviders } from "@/lib/outreach/providers/resolve";
import { allocateResearch } from "@/lib/outreach/research/attempt";
import { RANK_TIERS } from "@/lib/outreach/types";
import type {
  OutreachConfidence,
  OutreachEmailStatus,
  OutreachFundingSource,
  OutreachProspectFlags,
  OutreachRankExplanation,
  OutreachRankTier,
  OutreachResearchState,
} from "@/lib/outreach/types";

export type PeopleFilter = {
  tiers?: OutreachRankTier[];
  selection?: "any" | "selected" | "unselected";
  hasEmail?: boolean;
  researched?: boolean;
  includeFiltered?: boolean;
  includeExcluded?: boolean;
};

export type PersonEvidence = { id: string; provider: string; url: string | null; title: string | null; snippet: string | null };

export type PersonRow = {
  id: string;
  fullName: string;
  headline: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  linkedinUrl: string | null;
  email: string | null;
  emailStatus: OutreachEmailStatus | null;
  rankTier: OutreachRankTier | null;
  rankScore: number | null;
  researchConfidence: OutreachConfidence | null;
  researchState: OutreachResearchState;
  rankExplanation: OutreachRankExplanation | null;
  status: string;
  flags: OutreachProspectFlags;
  possibleDuplicateOf: string | null;
  duplicateReview: string | null;
  contactId: string | null;
  origin: string | null;
  stale: boolean;
  evidence: PersonEvidence[];
};

export type PeopleCounts = {
  total: number;
  strong: number;
  possible: number;
  weak: number;
  filtered: number;
  unranked: number;
  selected: number;
  excluded: number;
};

const TIER_ORDER = sql`CASE ${outreachProspects.rankTier} WHEN 'strong' THEN 0 WHEN 'possible' THEN 1 WHEN 'weak' THEN 2 WHEN 'filtered' THEN 3 ELSE 4 END`;
const NOT_IN_CONVERSATION = sql`NOT EXISTS (SELECT 1 FROM outreach_conversations oc WHERE oc.prospect_id = outreach_prospects.id)`;

function conditions(userId: string, campaignId: string, filter: PeopleFilter): SQL[] {
  const out: SQL[] = [eq(outreachProspects.userId, userId), eq(outreachProspects.campaignId, campaignId)];
  if (!filter.includeExcluded) out.push(ne(outreachProspects.status, "excluded"));
  // Clamp to the known tier set: an empty result after filtering (no tiers, or only bogus ones)
  // falls through to the default branch rather than an `inArray` with nothing in it.
  const validTiers = filter.tiers?.filter((t) => (RANK_TIERS as readonly string[]).includes(t));
  if (validTiers?.length) out.push(inArray(outreachProspects.rankTier, validTiers));
  else if (!filter.includeFiltered) out.push(or(isNull(outreachProspects.rankTier), ne(outreachProspects.rankTier, "filtered"))!);
  if (filter.selection === "selected") out.push(eq(outreachProspects.status, "selected"));
  if (filter.selection === "unselected") out.push(eq(outreachProspects.status, "suggested"));
  if (filter.hasEmail) out.push(isNotNull(outreachProspects.email));
  if (filter.researched) out.push(inArray(outreachProspects.researchState, ["done", "partial"]));
  return out;
}

export async function listPeople(
  userId: string,
  campaignId: string,
  opts: { filter?: PeopleFilter; offset?: number; limit?: number } = {}
) {
  const filter = opts.filter ?? {};
  // 200, not 100: the People page's live refresh re-reads everything already loaded.
  const limit = Math.min(200, Math.max(1, opts.limit ?? 25));
  const offset = Math.max(0, opts.offset ?? 0);
  const db = await getDb();
  const campaign = await getCampaignV2(userId, campaignId);
  const empty: PeopleCounts = { total: 0, strong: 0, possible: 0, weak: 0, filtered: 0, unranked: 0, selected: 0, excluded: 0 };
  if (!campaign) return { rows: [] as PersonRow[], nextOffset: null, total: 0, counts: empty, criteriaVersion: 0 };

  const where = and(...conditions(userId, campaignId, filter));
  const [rows, [{ n: total }], grouped] = await Promise.all([
    db
      .select()
      .from(outreachProspects)
      .where(where)
      .orderBy(TIER_ORDER, sql`${outreachProspects.rankScore} DESC NULLS LAST`, outreachProspects.createdAt, outreachProspects.id)
      .limit(limit)
      .offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(outreachProspects).where(where),
    db
      .select({
        tier: outreachProspects.rankTier,
        status: outreachProspects.status,
        n: sql<number>`count(*)::int`,
      })
      .from(outreachProspects)
      .where(and(eq(outreachProspects.userId, userId), eq(outreachProspects.campaignId, campaignId)))
      .groupBy(outreachProspects.rankTier, outreachProspects.status),
  ]);

  const counts = { ...empty };
  for (const g of grouped) {
    const n = Number(g.n);
    counts.total += n;
    if (g.status === "excluded") counts.excluded += n;
    if (g.status === "selected") counts.selected += n;
    if (g.tier === null) counts.unranked += n;
    else counts[g.tier] += n;
  }

  const evidence = rows.length
    ? await db
        .select({
          id: outreachEvidence.id,
          prospectId: outreachEvidence.prospectId,
          provider: outreachEvidence.provider,
          url: outreachEvidence.url,
          title: outreachEvidence.title,
          snippet: outreachEvidence.snippet,
        })
        .from(outreachEvidence)
        .where(and(eq(outreachEvidence.userId, userId), inArray(outreachEvidence.prospectId, rows.map((r) => r.id))))
        .orderBy(desc(outreachEvidence.createdAt))
    : [];

  const people: PersonRow[] = rows.map((r) => ({
    id: r.id,
    fullName: r.fullName,
    headline: r.headline,
    title: r.title,
    company: r.company,
    location: r.location,
    linkedinUrl: r.linkedinUrl,
    email: r.email,
    emailStatus: r.emailStatus,
    rankTier: r.rankTier,
    rankScore: r.rankScore,
    researchConfidence: r.researchConfidence,
    researchState: r.researchState,
    rankExplanation: r.rankExplanation,
    status: r.status,
    flags: r.flags ?? {},
    possibleDuplicateOf: r.possibleDuplicateOf,
    duplicateReview: r.duplicateReview,
    contactId: r.contactId,
    origin: r.origin,
    stale: r.rankedCriteriaVersion !== null && r.rankedCriteriaVersion < campaign.criteriaVersion,
    evidence: evidence
      .filter((e) => e.prospectId === r.id)
      .slice(0, 4)
      .map(({ prospectId: _prospectId, ...e }) => e),
  }));
  const count = Number(total);
  return {
    rows: people,
    nextOffset: offset + rows.length < count ? offset + rows.length : null,
    total: count,
    counts,
    criteriaVersion: campaign.criteriaVersion,
  };
}

/**
 * Two distinct operations (spec §7.7): `ids` changes exactly the rows sent (a page), `filter`
 * changes every row matching at this moment minus `exceptIds`. Neither touches excluded people
 * or anyone already in a conversation, and a filter never sweeps up filtered-out people unless
 * it names that tier.
 */
export async function selectPeople(
  userId: string,
  campaignId: string,
  input:
    | { scope: "ids"; ids: string[]; selected: boolean }
    | { scope: "filter"; filter: PeopleFilter; exceptIds: string[]; selected: boolean }
): Promise<{ changed: number }> {
  const db = await getDb();
  const base: SQL[] = [
    eq(outreachProspects.userId, userId),
    eq(outreachProspects.campaignId, campaignId),
    ne(outreachProspects.status, "excluded"),
    NOT_IN_CONVERSATION,
  ];
  let scope: SQL[];
  if (input.scope === "ids") {
    const ids = input.ids.slice(0, 500);
    if (ids.length === 0) return { changed: 0 };
    scope = [inArray(outreachProspects.id, ids)];
  } else {
    scope = conditions(userId, campaignId, { ...input.filter, includeExcluded: false, selection: "any" });
    if (input.exceptIds.length) scope.push(notInArray(outreachProspects.id, input.exceptIds.slice(0, 500)));
  }
  const target = input.selected ? "selected" : "suggested";
  // Bare `.returning()`, not `.returning({ id })` — an explicit field selector defeats
  // Drizzle's overload resolution after `.update()` against the union `Db` type in this repo
  // (the same trap noted in queue.ts, contact-identity.ts, action-items.ts and
  // import-engine.ts). Only the count is needed, so `.length` on the full rows costs nothing.
  const rows = await db
    .update(outreachProspects)
    .set({ status: target, updatedAt: new Date() })
    .where(and(...base, ...scope, ne(outreachProspects.status, target)))
    .returning();
  return { changed: rows.length };
}

export async function excludePeople(userId: string, campaignId: string, ids: string[], reason: string | null) {
  if (ids.length === 0) return { changed: 0 };
  const db = await getDb();
  // Bare `.returning()` — see the note in `selectPeople` above.
  const rows = await db
    .update(outreachProspects)
    .set({ status: "excluded", excludedReason: reason?.slice(0, 200) ?? null, updatedAt: new Date() })
    .where(
      and(
        eq(outreachProspects.userId, userId),
        eq(outreachProspects.campaignId, campaignId),
        inArray(outreachProspects.id, ids.slice(0, 500)),
        NOT_IN_CONVERSATION
      )
    )
    .returning();
  return { changed: rows.length };
}

export async function restorePeople(userId: string, campaignId: string, ids: string[]) {
  if (ids.length === 0) return { changed: 0 };
  const db = await getDb();
  // Bare `.returning()` — see the note in `selectPeople` above.
  const rows = await db
    .update(outreachProspects)
    .set({ status: "suggested", excludedReason: null, updatedAt: new Date() })
    .where(
      and(
        eq(outreachProspects.userId, userId),
        eq(outreachProspects.campaignId, campaignId),
        inArray(outreachProspects.id, ids.slice(0, 500)),
        eq(outreachProspects.status, "excluded")
      )
    )
    .returning();
  return { changed: rows.length };
}

export async function resolveDuplicate(userId: string, prospectId: string, decision: "distinct" | "merged") {
  const db = await getDb();
  await db
    .update(outreachProspects)
    .set(
      decision === "merged"
        ? { status: "excluded", excludedReason: "Duplicate of another person in this campaign", duplicateReview: "merged", updatedAt: new Date() }
        : { duplicateReview: "distinct", updatedAt: new Date() }
    )
    .where(and(eq(outreachProspects.id, prospectId), eq(outreachProspects.userId, userId)));
}

/**
 * Research one more person outside a run: a hold of one credit (Orbit) or none (personal).
 *
 * Controller ruling (overrides the brief): this is check-then-act on `research_state`, so a
 * double-click must not queue two attempts and spend two credits. The claim against
 * `research_state` is ONE conditional UPDATE — only one of two concurrent callers for the same
 * person can move it to `queued`; the other is turned away before anything is reserved. Any
 * failure after the claim restores the prior `research_state` and releases a hold already taken.
 */
export async function researchOnePerson(
  userId: string,
  prospectId: string,
  fundingInput: OutreachFundingSource
): Promise<{ attemptId: string }> {
  // First, before any lookup or claim: only "orbit" (a one-credit hold) or "personal" (none).
  const funding = parseFundingSource(fundingInput);
  const db = await getDb();
  const [prospect] = await db
    .select({ id: outreachProspects.id, campaignId: outreachProspects.campaignId, researchState: outreachProspects.researchState })
    .from(outreachProspects)
    .where(and(eq(outreachProspects.id, prospectId), eq(outreachProspects.userId, userId)));
  if (!prospect) throw new UserFacingError("That person isn’t in your campaign");

  // Resolve providers FIRST — no side effects yet — so a missing key never claims the slot.
  const providers = await resolveResearchProviders(userId, funding);
  if (!providers.enrichment) {
    throw new UserFacingError("Add your Apollo key in Settings to research people with your own keys");
  }

  const priorState = prospect.researchState;
  const claimed = await db
    .update(outreachProspects)
    .set({ researchState: "queued", updatedAt: new Date() })
    .where(
      and(
        eq(outreachProspects.id, prospectId),
        eq(outreachProspects.userId, userId),
        notInArray(outreachProspects.researchState, ["queued", "running"])
      )
    )
    // Bare `.returning()` — see the note in `selectPeople` above.
    .returning();
  if (claimed.length === 0) {
    throw new UserFacingError("Research on this person is already underway");
  }

  let holdId: string | null = null;
  try {
    if (funding === "orbit") {
      const hold = await reserveCredits(userId, { want: 1, min: 1, idempotencyKey: `reserve:person:${prospectId}:${randomUUID()}` });
      if (!hold) {
        const balance = await getCreditBalance(userId);
        throw new UserFacingError(
          `You’re out of research credits — they refresh on ${balance.periodEnd.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
        );
      }
      holdId = hold.holdId;
    }
    const attemptId = await allocateResearch(userId, { campaignId: prospect.campaignId, prospectId, runId: null, funding, holdId });
    if (!attemptId) throw new UserFacingError("Research couldn’t start — try again");
    return { attemptId };
  } catch (err) {
    // Undo only OUR claim: gated on research_state still being 'queued', so a newer state
    // written by someone else in this window (a job that raced ahead, another restore) is
    // never clobbered.
    await db
      .update(outreachProspects)
      .set({ researchState: priorState, updatedAt: new Date() })
      .where(
        and(
          eq(outreachProspects.id, prospectId),
          eq(outreachProspects.userId, userId),
          eq(outreachProspects.researchState, "queued")
        )
      );
    if (holdId) await releaseHold(userId, holdId);
    throw err;
  }
}
