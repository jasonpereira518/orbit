import { createHash } from "node:crypto";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  contactIdentities,
  outreachCampaigns,
  outreachEvidence,
  outreachIdentities,
  outreachProspects,
  outreachSuppressions,
} from "@/db/schema";
import { OUTREACH_LIMITS } from "@/lib/outreach/config";
import {
  canonicalLinkedinUrl,
  externalIdFor,
  likelySamePerson,
  normalizeEmail,
  outreachIdentitiesFor,
  type OutreachIdentity,
} from "@/lib/outreach/identity";
import type { OutreachProspectFlags, OutreachProspectOrigin } from "@/lib/outreach/types";

export type EvidenceInput = {
  kind: "search_result" | "enrichment" | "web_page" | "user_note";
  provider: "brave" | "apollo" | "user" | "demo";
  url: string | null;
  title: string | null;
  snippet: string | null;
  facts?: Record<string, unknown>;
  runId?: string | null;
};

export type CandidateInput = {
  fullName: string;
  headline?: string | null;
  title?: string | null;
  company?: string | null;
  location?: string | null;
  linkedinUrl?: string | null;
  email?: string | null;
  apolloId?: string | null;
  origin: OutreachProspectOrigin;
  evidence: EvidenceInput[];
};

/** `kind:value` → campaigns in which that identity was already contacted. */
export type OutreachHistory = Map<string, Array<{ id: string; name: string }>>;

const PIPELINE_STATUSES = ["contacted", "replied", "interested", "not_interested"];

export function evidenceHash(e: EvidenceInput): string {
  return createHash("sha256")
    .update([e.provider, e.kind, e.url ?? "", e.title ?? "", e.snippet ?? ""].join("\u0001"))
    .digest("hex");
}

export async function addEvidence(
  userId: string,
  campaignId: string,
  prospectId: string,
  evidence: EvidenceInput[]
): Promise<number> {
  if (evidence.length === 0) return 0;
  const db = await getDb();
  const inserted = await db
    .insert(outreachEvidence)
    .values(
      evidence.map((e) => ({
        userId,
        campaignId,
        prospectId,
        runId: e.runId ?? null,
        kind: e.kind,
        provider: e.provider,
        url: e.url,
        title: e.title?.slice(0, 300) ?? null,
        snippet: e.snippet?.slice(0, OUTREACH_LIMITS.snippetMaxChars) ?? null,
        facts: e.facts ?? {},
        contentHash: evidenceHash(e),
      }))
    )
    .onConflictDoNothing()
    .returning();
  return inserted.length;
}

function identityMatch(identities: OutreachIdentity[]) {
  return or(
    ...identities.map((i) => and(eq(outreachIdentities.kind, i.kind), eq(outreachIdentities.value, i.value)))
  );
}

async function findByIdentity(campaignId: string, identities: OutreachIdentity[]): Promise<string | null> {
  if (identities.length === 0) return null;
  const db = await getDb();
  const [row] = await db
    .select({ prospectId: outreachIdentities.prospectId })
    .from(outreachIdentities)
    .where(and(eq(outreachIdentities.campaignId, campaignId), identityMatch(identities)))
    .limit(1);
  return row?.prospectId ?? null;
}

/** Returns another prospect that already owns one of these identities (a lost race), else null. */
export async function attachIdentities(
  userId: string,
  campaignId: string,
  prospectId: string,
  identities: OutreachIdentity[]
): Promise<string | null> {
  const db = await getDb();
  let conflict: string | null = null;
  for (const identity of identities) {
    const inserted = await db
      .insert(outreachIdentities)
      .values({ userId, campaignId, prospectId, kind: identity.kind, value: identity.value })
      .onConflictDoNothing()
      .returning();
    if (inserted.length) continue;
    const [owner] = await db
      .select({ prospectId: outreachIdentities.prospectId })
      .from(outreachIdentities)
      .where(and(eq(outreachIdentities.campaignId, campaignId), eq(outreachIdentities.kind, identity.kind), eq(outreachIdentities.value, identity.value)));
    if (owner && owner.prospectId !== prospectId) conflict ??= owner.prospectId;
  }
  return conflict;
}

/**
 * Everyone this user has already contacted, outside one campaign, keyed by identity. Built once
 * per discovery pass: generation-2 prospects that have a conversation, and legacy prospects
 * whose status says they were contacted (legacy rows have no identity rows until migration).
 */
export async function loadOutreachHistory(userId: string, excludeCampaignId: string): Promise<OutreachHistory> {
  const db = await getDb();
  const rows = await db
    .select({
      prospectId: outreachProspects.id,
      linkedinUrl: outreachProspects.linkedinUrl,
      email: outreachProspects.email,
      campaignId: outreachCampaigns.id,
      campaignName: outreachCampaigns.name,
    })
    .from(outreachProspects)
    .innerJoin(outreachCampaigns, eq(outreachCampaigns.id, outreachProspects.campaignId))
    .where(
      and(
        eq(outreachCampaigns.userId, userId),
        ne(outreachCampaigns.id, excludeCampaignId),
        or(
          inArray(outreachProspects.status, PIPELINE_STATUSES),
          // Literal qualified column — see the drizzle unqualified-column note in campaigns.ts.
          sql`exists (select 1 from outreach_conversations oc where oc.prospect_id = outreach_prospects.id)`
        )
      )
    );
  const history: OutreachHistory = new Map();
  for (const row of rows) {
    for (const identity of outreachIdentitiesFor({ linkedinUrl: row.linkedinUrl, email: row.email })) {
      const key = `${identity.kind}:${identity.value}`;
      const list = history.get(key) ?? [];
      if (!list.some((c) => c.id === row.campaignId)) list.push({ id: row.campaignId, name: row.campaignName });
      history.set(key, list);
    }
  }
  return history;
}

async function computeFlags(
  userId: string,
  identities: OutreachIdentity[],
  history: OutreachHistory
): Promise<{ flags: OutreachProspectFlags; contactId: string | null }> {
  const flags: OutreachProspectFlags = {};
  const strong = identities.filter((i) => i.kind === "linkedin_slug" || i.kind === "email") as Array<{ kind: "linkedin_slug" | "email"; value: string }>;
  let contactId: string | null = null;
  if (strong.length) {
    const db = await getDb();
    const [contact] = await db
      .select({ contactId: contactIdentities.contactId })
      .from(contactIdentities)
      .where(
        and(
          eq(contactIdentities.userId, userId),
          or(...strong.map((i) => and(eq(contactIdentities.kind, i.kind), eq(contactIdentities.value, i.value))))
        )
      )
      .limit(1);
    if (contact) {
      contactId = contact.contactId;
      flags.existingContactId = contact.contactId;
    }
    const [suppression] = await db
      .select({ reason: outreachSuppressions.reason })
      .from(outreachSuppressions)
      .where(
        and(
          eq(outreachSuppressions.userId, userId),
          or(...strong.map((i) => and(eq(outreachSuppressions.kind, i.kind), eq(outreachSuppressions.value, i.value))))
        )
      )
      .limit(1);
    if (suppression) flags.suppressed = suppression.reason;
  }
  const previous = identities.flatMap((i) => history.get(`${i.kind}:${i.value}`) ?? []);
  if (previous.length) flags.previousCampaigns = previous.filter((c, i) => previous.findIndex((d) => d.id === c.id) === i);
  return { flags, contactId };
}

async function findNameDuplicate(userId: string, campaignId: string, input: CandidateInput): Promise<string | null> {
  if (!input.company) return null;
  const db = await getDb();
  const rows = await db
    .select({ id: outreachProspects.id, fullName: outreachProspects.fullName, company: outreachProspects.company })
    .from(outreachProspects)
    .where(and(eq(outreachProspects.userId, userId), eq(outreachProspects.campaignId, campaignId)))
    .limit(1000);
  const match = rows.find((r) => likelySamePerson({ fullName: input.fullName, company: input.company ?? null }, r));
  return match?.id ?? null;
}

async function mergeInto(
  userId: string,
  campaignId: string,
  prospectId: string,
  input: CandidateInput,
  identities: OutreachIdentity[]
) {
  const db = await getDb();
  await db
    .update(outreachProspects)
    .set({
      headline: sql`coalesce(${outreachProspects.headline}, ${input.headline ?? null})`,
      title: sql`coalesce(${outreachProspects.title}, ${input.title ?? null})`,
      company: sql`coalesce(${outreachProspects.company}, ${input.company ?? null})`,
      location: sql`coalesce(${outreachProspects.location}, ${input.location ?? null})`,
      linkedinUrl: sql`coalesce(${outreachProspects.linkedinUrl}, ${canonicalLinkedinUrl(input.linkedinUrl)})`,
      updatedAt: new Date(),
    })
    .where(and(eq(outreachProspects.id, prospectId), eq(outreachProspects.userId, userId)));
  await attachIdentities(userId, campaignId, prospectId, identities);
  await addEvidence(userId, campaignId, prospectId, input.evidence);
}

/**
 * Insert-or-merge by identity. The unique index on (campaign, kind, value) is the real guard;
 * the lookup first is only so the common "seen again" case merges without a failed insert.
 */
export async function upsertCandidate(
  userId: string,
  campaignId: string,
  input: CandidateInput,
  opts: { history?: OutreachHistory; trustedCampaign?: boolean } = {}
): Promise<{ prospectId: string; created: boolean; possibleDuplicateOf: string | null }> {
  if (!opts.trustedCampaign) {
    // Callers that already loaded the campaign as this user (the discovery run) skip the probe.
    const db = await getDb();
    const [owned] = await db
      .select({ id: outreachCampaigns.id })
      .from(outreachCampaigns)
      .where(and(eq(outreachCampaigns.id, campaignId), eq(outreachCampaigns.userId, userId)));
    if (!owned) throw new Error("Campaign not found for this user");
  }
  const identities = outreachIdentitiesFor(input);
  const existing = await findByIdentity(campaignId, identities);
  if (existing) {
    await mergeInto(userId, campaignId, existing, input, identities);
    return { prospectId: existing, created: false, possibleDuplicateOf: null };
  }

  const history = opts.history ?? (await loadOutreachHistory(userId, campaignId));
  const [{ flags, contactId }, nameDuplicate] = await Promise.all([
    computeFlags(userId, identities, history),
    findNameDuplicate(userId, campaignId, input),
  ]);
  const db = await getDb();
  const externalId = externalIdFor(identities);
  const [inserted] = await db
    .insert(outreachProspects)
    .values({
      userId,
      campaignId,
      externalId,
      fullName: input.fullName.slice(0, 160),
      headline: input.headline ?? null,
      title: input.title ?? null,
      company: input.company ?? null,
      location: input.location ?? null,
      linkedinUrl: canonicalLinkedinUrl(input.linkedinUrl),
      email: normalizeEmail(input.email),
      origin: input.origin,
      status: "suggested",
      contactId,
      flags,
      possibleDuplicateOf: nameDuplicate,
      duplicateReview: nameDuplicate ? "pending" : null,
    })
    .onConflictDoNothing({ target: [outreachProspects.campaignId, outreachProspects.externalId] })
    .returning();

  if (!inserted) {
    const [raced] = await db
      .select({ id: outreachProspects.id })
      .from(outreachProspects)
      .where(and(eq(outreachProspects.campaignId, campaignId), eq(outreachProspects.externalId, externalId)));
    await mergeInto(userId, campaignId, raced.id, input, identities);
    return { prospectId: raced.id, created: false, possibleDuplicateOf: null };
  }

  const lostTo = await attachIdentities(userId, campaignId, inserted.id, identities);
  if (lostTo && !nameDuplicate) {
    await db
      .update(outreachProspects)
      .set({ possibleDuplicateOf: lostTo, duplicateReview: "pending" })
      .where(eq(outreachProspects.id, inserted.id));
  }
  await addEvidence(userId, campaignId, inserted.id, input.evidence);
  return { prospectId: inserted.id, created: true, possibleDuplicateOf: nameDuplicate ?? lostTo };
}
