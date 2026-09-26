"use server";

import { and, desc, eq, inArray, lte, sql, type SQL } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, runAtomicWrite, type AtomicStatement } from "@/db";
import {
  interactions,
  outreachCampaigns,
  outreachMessages,
  outreachProspects,
  type AudienceFilters,
  type OutreachSequenceStep,
} from "@/db/schema";
import { createContact, logInteraction } from "@/actions/contacts";
import { listActiveGoalTexts } from "@/actions/goals";
import {
  companyMatchesOrganizations,
  enrichPerson,
  parseAudienceToFilters,
  searchPeople,
  userHasApolloKey,
} from "@/lib/apollo";
import { requireUserId } from "@/lib/auth";
import { requireOutreachUser } from "@/lib/plan-guards";
import {
  computeCampaignMetrics,
  computeChannelBreakdown,
  computeStepBreakdown,
} from "@/lib/outreach-metrics";
import { campaignMetricAggregates, metricsFromAggregates } from "@/lib/outreach-metrics-sql";
import {
  generateOutreachDraft,
  generateOutreachDraftsBatch,
} from "@/lib/outreach-drafts";
import {
  assessOutreachQuality,
  DEMO_PROSPECT_SEND_MESSAGE,
  isDemoProspect,
  prospectSearchStatus,
} from "@/lib/outreach-quality";
import { sendOutreachMessage } from "@/lib/outreach-send";
import { loadWritingInstructions } from "@/lib/writing-instructions-store";
import {
  BULK_SEND_LIMIT,
  OUTREACH_CHANNELS,
  type OutreachChannel,
  type OutreachMessageOutcome,
  type OutreachMessageStatus,
  type SequenceStep,
} from "@/lib/outreach-types";
import { asActionResult, UserFacingError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";
import { actionFailure } from "@/lib/action-failure";

async function requireCampaign(userId: string, campaignId: string) {
  const db = await getDb();
  const campaign = await db.query.outreachCampaigns.findFirst({
    where: and(
      eq(outreachCampaigns.id, campaignId),
      eq(outreachCampaigns.userId, userId)
    ),
  });
  if (!campaign) throw new Error("Campaign not found");
  return campaign;
}

function enrichmentSummary(enrichment: unknown): string | null {
  if (!enrichment || typeof enrichment !== "object") return null;
  const record = enrichment as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of [
    "headline",
    "summary",
    "bio",
    "seniority",
    "departments",
    "keywords",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      parts.push(`${key}: ${value.trim()}`);
    } else if (Array.isArray(value) && value.length) {
      parts.push(`${key}: ${value.slice(0, 5).join(", ")}`);
    }
  }
  return parts.length ? parts.join("; ").slice(0, 500) : null;
}

/**
 * One interaction's contribution to a prior-notes string: the summary, else the raw notes.
 *
 * Cut to 500 characters in SQL because the joined string is cut to 500 afterwards, so no
 * part can contribute more than that — and `raw_notes` on an imported email can be many KB.
 * `left()` counts code points and `.slice()` UTF-16 units; a 500-code-point prefix is at
 * least 500 units long, so the final `.slice(0, 500)` is unchanged. `nullif(…, '')` is the
 * `||` fallback: an empty summary falls through to the raw notes, as it did in JavaScript.
 */
const priorNoteSql = sql<string | null>`left(coalesce(nullif(${interactions.aiSummary}, ''), ${interactions.rawNotes}), 500)`;

function joinPriorNotes(notes: (string | null)[]) {
  return notes.filter(Boolean).join(" | ").slice(0, 500);
}

async function priorNotesForContact(userId: string, contactId: string | null) {
  if (!contactId) return null;
  const db = await getDb();
  const rows = await db
    .select({ note: priorNoteSql })
    .from(interactions)
    .where(and(eq(interactions.userId, userId), eq(interactions.contactId, contactId)))
    .orderBy(desc(interactions.interactionDate))
    .limit(3);
  if (!rows.length) return null;
  return joinPriorNotes(rows.map((row) => row.note));
}

/**
 * Batched form of `priorNotesForContact` for draft generation over a whole prospect
 * list — one `interactions` query instead of one per prospect. Returns a map whose
 * values match `priorNotesForContact`'s per-contact string shape exactly (a contact
 * with no interaction rows simply has no entry, so callers fall back with `?? null`).
 *
 * The three newest per contact are chosen in SQL (`row_number()` over each contact, newest
 * first — the order the single-contact read uses), so only those rows, and only the one
 * column the string is built from, come back. It used to read every interaction of every
 * prospect's contact, whole rows, and keep three each in JavaScript. Scoped to the caller's
 * account like the single-contact read.
 */
async function priorNotesForContacts(userId: string, contactIds: string[]) {
  const byContact = new Map<string, string>();
  if (!contactIds.length) return byContact;
  const db = await getDb();
  const ranked = db
    .select({
      contactId: interactions.contactId,
      note: priorNoteSql.as("note"),
      rn: sql<number>`row_number() over (
        partition by ${interactions.contactId}
        order by ${interactions.interactionDate} desc
      )`.as("rn"),
    })
    .from(interactions)
    .where(and(eq(interactions.userId, userId), inArray(interactions.contactId, contactIds)))
    .as("ranked");
  const rows = await db
    .select({ contactId: ranked.contactId, note: ranked.note })
    .from(ranked)
    .where(sql`${ranked.rn} <= 3`)
    .orderBy(ranked.contactId, ranked.rn);
  const grouped = new Map<string, (string | null)[]>();
  for (const row of rows) {
    const list = grouped.get(row.contactId) ?? [];
    list.push(row.note);
    grouped.set(row.contactId, list);
  }
  for (const [contactId, notes] of grouped) {
    byContact.set(contactId, joinPriorNotes(notes));
  }
  return byContact;
}

/**
 * Every campaign row, with its metrics counted in SQL (`campaignMetricAggregates`) — one row
 * a campaign. The list only ever used the prospect/message tree it used to load to count it:
 * the card shows `metrics.prospectCount` for the prospects it used to `.length`.
 */
export async function listCampaigns() {
  const userId = await requireUserId();
  const db = await getDb();
  const rows = await db
    .select({
      campaign: outreachCampaigns,
      counts: campaignMetricAggregates(new Date()),
    })
    .from(outreachCampaigns)
    .leftJoin(outreachProspects, eq(outreachProspects.campaignId, outreachCampaigns.id))
    .leftJoin(outreachMessages, eq(outreachMessages.prospectId, outreachProspects.id))
    .where(eq(outreachCampaigns.userId, userId))
    .groupBy(outreachCampaigns.id)
    .orderBy(desc(outreachCampaigns.updatedAt), desc(outreachCampaigns.id));

  return rows.map(({ campaign, counts }) => ({
    ...campaign,
    metrics: metricsFromAggregates(counts),
  }));
}

export async function getCampaign(campaignId: string) {
  const userId = await requireUserId();
  const db = await getDb();
  const campaign = await db.query.outreachCampaigns.findFirst({
    where: and(
      eq(outreachCampaigns.id, campaignId),
      eq(outreachCampaigns.userId, userId)
    ),
    with: {
      prospects: {
        orderBy: [desc(outreachProspects.createdAt)],
        with: {
          messages: {
            orderBy: [desc(outreachMessages.updatedAt)],
          },
        },
      },
    },
  });
  if (!campaign) throw new Error("Campaign not found");

  const metrics = computeCampaignMetrics(campaign.prospects);
  return {
    ...campaign,
    metrics,
    channelBreakdown: computeChannelBreakdown(campaign.prospects),
    stepBreakdown: computeStepBreakdown(campaign.prospects),
  };
}

export async function getOutreachPerformanceSummary() {
  const userId = await requireUserId();
  const db = await getDb();

  // One row of counts a campaign, aggregated in SQL — it used to load every prospect and
  // message of every campaign to count them here. Same order as the outreach list.
  const campaigns = await db
    .select({
      id: outreachCampaigns.id,
      name: outreachCampaigns.name,
      status: outreachCampaigns.status,
      defaultChannel: outreachCampaigns.defaultChannel,
      counts: campaignMetricAggregates(new Date()),
    })
    .from(outreachCampaigns)
    .leftJoin(outreachProspects, eq(outreachProspects.campaignId, outreachCampaigns.id))
    .leftJoin(outreachMessages, eq(outreachMessages.prospectId, outreachProspects.id))
    .where(eq(outreachCampaigns.userId, userId))
    .groupBy(outreachCampaigns.id)
    .orderBy(desc(outreachCampaigns.updatedAt), desc(outreachCampaigns.id));

  const withMetrics = campaigns.map(({ counts, ...campaign }) => ({
    ...campaign,
    metrics: metricsFromAggregates(counts),
  }));

  const ranked = [...withMetrics]
    .filter((c) => c.metrics.sentCount > 0)
    .sort((a, b) => {
      const aRate = a.metrics.successfulReplyRate ?? -1;
      const bRate = b.metrics.successfulReplyRate ?? -1;
      if (bRate !== aRate) return bRate - aRate;
      return b.metrics.positiveReplyCount - a.metrics.positiveReplyCount;
    })
    .slice(0, 5)
    .map((c) => ({
      id: c.id,
      name: c.name,
      metrics: c.metrics,
      defaultChannel: c.defaultChannel,
      status: c.status,
    }));

  const totals = withMetrics.reduce(
    (acc, c) => {
      acc.sent += c.metrics.sentCount;
      acc.bounced += c.metrics.bouncedCount;
      acc.positive += c.metrics.positiveReplyCount;
      acc.replies += c.metrics.replyCount;
      return acc;
    },
    { sent: 0, bounced: 0, positive: 0, replies: 0 }
  );
  const eligible = Math.max(0, totals.sent - totals.bounced);

  return {
    topCampaigns: ranked,
    accountMetrics: {
      sentCount: totals.sent,
      replyCount: totals.replies,
      positiveReplyCount: totals.positive,
      successfulReplyRate: eligible > 0 ? totals.positive / eligible : null,
      campaignCount: campaigns.length,
    },
  };
}

export async function createCampaign(input: {
  name: string;
  audienceQuery: string;
  audienceFilters?: AudienceFilters;
  replyCta?: string | null;
  sequenceSteps?: SequenceStep[];
}) {
  const userId = await requireOutreachUser();
  const db = await getDb();

  const filters =
    input.audienceFilters ??
    (input.audienceQuery.trim()
      ? await parseAudienceToFilters(userId, input.audienceQuery)
      : {});

  const [campaign] = await db
    .insert(outreachCampaigns)
    .values({
      userId,
      name: input.name.trim() || "Untitled campaign",
      audienceQuery: input.audienceQuery.trim(),
      audienceFilters: filters,
      replyCta: input.replyCta ?? null,
      sequenceSteps: (input.sequenceSteps ?? []) as OutreachSequenceStep[],
      status: "draft",
    })
    .returning();

  revalidatePath("/outreach");
  return campaign;
}

const CAMPAIGN_TEXT_MAX = 4_000;
const MAX_SEQUENCE_STEPS = 20;

function campaignText(value: unknown, field: string, nullable: boolean): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null && nullable) return null;
  if (typeof value !== "string") throw new UserFacingError(`Invalid ${field}`);
  return value.slice(0, CAMPAIGN_TEXT_MAX);
}

function pickCampaignFields(input: Record<string, unknown>) {
  const fields: {
    name?: string;
    audienceQuery?: string;
    messageIntent?: string | null;
    replyCta?: string | null;
    tone?: string;
    defaultChannel?: OutreachChannel;
    status?: string;
  } = {};
  const name = campaignText(input.name, "name", false);
  if (name !== undefined) fields.name = name ?? "";
  const audienceQuery = campaignText(input.audienceQuery, "audience", false);
  if (audienceQuery !== undefined) fields.audienceQuery = audienceQuery ?? "";
  const messageIntent = campaignText(input.messageIntent, "message intent", true);
  if (messageIntent !== undefined) fields.messageIntent = messageIntent;
  const replyCta = campaignText(input.replyCta, "call to action", true);
  if (replyCta !== undefined) fields.replyCta = replyCta;
  const tone = campaignText(input.tone, "tone", false);
  if (tone !== undefined) fields.tone = (tone ?? "").slice(0, 64);
  const status = campaignText(input.status, "status", false);
  if (status !== undefined) fields.status = (status ?? "").slice(0, 32);
  if (input.defaultChannel !== undefined) {
    if (!OUTREACH_CHANNELS.includes(input.defaultChannel as OutreachChannel)) {
      throw new UserFacingError("Invalid channel");
    }
    fields.defaultChannel = input.defaultChannel as OutreachChannel;
  }
  return fields;
}

export async function updateCampaign(
  campaignId: string,
  input: {
    name?: string;
    audienceQuery?: string;
    audienceFilters?: AudienceFilters;
    messageIntent?: string | null;
    replyCta?: string | null;
    tone?: string;
    defaultChannel?: OutreachChannel;
    status?: string;
    sequenceSteps?: SequenceStep[];
    reparseAudience?: boolean;
  }
) {
  const userId = await requireOutreachUser();
  await requireCampaign(userId, campaignId);
  const db = await getDb();

  const { reparseAudience, sequenceSteps, audienceFilters } = input;
  // Allowlisted, never spread: every export here is a public POST endpoint, and spreading
  // the argument into `.set()` let a caller write any real column — `userId` included,
  // which moved a campaign and its drafts into another account.
  const fields = pickCampaignFields(input as Record<string, unknown>);
  const patch: Record<string, unknown> = {
    ...fields,
    updatedAt: new Date(),
  };

  if (sequenceSteps !== undefined) {
    if (!Array.isArray(sequenceSteps) || sequenceSteps.length > MAX_SEQUENCE_STEPS) {
      throw new UserFacingError(`A sequence can have at most ${MAX_SEQUENCE_STEPS} steps`);
    }
    patch.sequenceSteps = sequenceSteps as OutreachSequenceStep[];
  }

  if (audienceFilters !== undefined) {
    patch.audienceFilters = audienceFilters;
  } else if (fields.audienceQuery !== undefined && reparseAudience !== false) {
    patch.audienceFilters = fields.audienceQuery.trim()
      ? await parseAudienceToFilters(userId, fields.audienceQuery)
      : {};
  }

  const [updated] = await db
    .update(outreachCampaigns)
    .set(patch)
    .where(and(eq(outreachCampaigns.id, campaignId), eq(outreachCampaigns.userId, userId)))
    .returning();

  revalidatePath("/outreach");
  revalidatePath(`/outreach/${campaignId}`);
  return updated;
}

/** Returned as data so the hosted-Apollo daily cap copy survives the action boundary. */
export async function searchProspects(campaignId: string, page = 1) {
  return asActionResult(() => searchProspectsCore(campaignId, page));
}

async function searchProspectsCore(campaignId: string, page = 1) {
  const userId = await requireOutreachUser();
  const campaign = await requireCampaign(userId, campaignId);
  const db = await getDb();

  const filters = (campaign.audienceFilters ?? {}) as AudienceFilters;
  const { prospects, total, source } = await searchPeople(userId, filters, page);

  let matched = 0;
  let mismatched = 0;

  // One multi-row upsert instead of one per prospect (each is its own HTTPS round trip on
  // neon-http). Keyed by `externalId` because Postgres refuses an ON CONFLICT statement
  // that touches the same conflict row twice; the last occurrence wins, which is what the
  // old insert-then-update sequence left behind. The first occurrence keeps its slot, so
  // a new row gets the `created_at` rank it would have had.
  const rowsByExternalId = new Map<
    string,
    { slot: number; values: Omit<typeof outreachProspects.$inferInsert, "createdAt"> }
  >();

  prospects.forEach((prospect, index) => {
    const matchesOrg = companyMatchesOrganizations(
      prospect.company,
      filters.organizationNames
    );
    const isDemo = source === "demo" || Boolean(prospect.enrichment?.demo);
    const status = prospectSearchStatus({ matchesOrg, isDemo });
    if (matchesOrg) matched += 1;
    else mismatched += 1;

    const slot = rowsByExternalId.get(prospect.externalId)?.slot ?? index;
    rowsByExternalId.set(prospect.externalId, {
      slot,
      values: {
        campaignId,
        externalId: prospect.externalId,
        fullName: prospect.fullName,
        title: prospect.title,
        company: prospect.company,
        email: prospect.email,
        phone: prospect.phone,
        linkedinUrl: prospect.linkedinUrl,
        location: prospect.location,
        enrichment: {
          ...prospect.enrichment,
          demo: isDemo,
          companyMismatch: !matchesOrg,
        },
        status,
      },
    });
  });

  if (rowsByExternalId.size) {
    await db
      .insert(outreachProspects)
      .values(
        [...rowsByExternalId.values()].map(({ slot, values }) => ({
          ...values,
          // One statement means one `now()` for every row, where the per-row inserts each
          // got their own and the campaign page's `created_at desc` order followed the
          // search order. A microsecond per slot keeps that order deterministic.
          createdAt: sql`now() + ${slot}::integer * interval '1 microsecond'`,
        }))
      )
      .onConflictDoUpdate({
        target: [outreachProspects.campaignId, outreachProspects.externalId],
        set: {
          fullName: sql`excluded.full_name`,
          title: sql`excluded.title`,
          company: sql`excluded.company`,
          email: sql`excluded.email`,
          phone: sql`excluded.phone`,
          linkedinUrl: sql`excluded.linkedin_url`,
          location: sql`excluded.location`,
          enrichment: sql`excluded.enrichment`,
          status: sql`excluded.status`,
          updatedAt: new Date(),
        },
      });
  }

  await db
    .update(outreachCampaigns)
    .set({
      status: "active",
      lastSearchSource: source,
      updatedAt: new Date(),
    })
    .where(eq(outreachCampaigns.id, campaignId));

  revalidatePath(`/outreach/${campaignId}`);
  return {
    imported: prospects.length,
    matched,
    mismatched,
    total,
    source,
  };
}

export async function getOutreachApolloStatus() {
  const userId = await requireUserId();
  return { hasApollo: await userHasApolloKey(userId) };
}

export async function updateProspectSelection(input: {
  campaignId: string;
  prospectIds: string[];
  status: "selected" | "excluded" | "suggested";
}) {
  const userId = await requireOutreachUser();
  await requireCampaign(userId, input.campaignId);
  const db = await getDb();

  await db
    .update(outreachProspects)
    .set({ status: input.status, updatedAt: new Date() })
    .where(
      and(
        eq(outreachProspects.campaignId, input.campaignId),
        inArray(outreachProspects.id, input.prospectIds)
      )
    );

  revalidatePath(`/outreach/${input.campaignId}`);
  return { ok: true };
}

async function upsertMessageForProspect(
  prospectId: string,
  channel: OutreachChannel,
  draft: { subject: string | null; body: string },
  options?: {
    stepIndex?: number;
    parentMessageId?: string | null;
    scheduledFor?: Date | null;
    status?: OutreachMessageStatus;
  }
) {
  const db = await getDb();
  const stepIndex = options?.stepIndex ?? 0;

  const existing = await db.query.outreachMessages.findFirst({
    where: and(
      eq(outreachMessages.prospectId, prospectId),
      eq(outreachMessages.channel, channel),
      eq(outreachMessages.stepIndex, stepIndex)
    ),
  });

  if (existing) {
    const [updated] = await db
      .update(outreachMessages)
      .set({
        subject: draft.subject,
        body: draft.body,
        status: options?.status ?? "generated",
        parentMessageId: options?.parentMessageId ?? existing.parentMessageId,
        scheduledFor: options?.scheduledFor ?? existing.scheduledFor,
        updatedAt: new Date(),
      })
      .where(eq(outreachMessages.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(outreachMessages)
    .values({
      prospectId,
      channel,
      subject: draft.subject,
      body: draft.body,
      status: options?.status ?? "generated",
      stepIndex,
      parentMessageId: options?.parentMessageId ?? null,
      scheduledFor: options?.scheduledFor ?? null,
    })
    .returning();
  return created;
}

/**
 * Set-based `upsertMessageForProspect` for the first step of many prospects at once, with
 * its default options: one read of the existing step-0 messages, then the inserts and the
 * updates together in one `runAtomicWrite` (a single request on neon-http) instead of a
 * find plus a write per prospect. There is no unique index on (prospect, channel, step),
 * so like `findFirst` it updates the first row it finds per prospect. Returns the count.
 */
async function upsertFirstStepMessages(
  items: Array<{ prospectId: string; draft: { subject: string | null; body: string } }>,
  channel: OutreachChannel
) {
  if (!items.length) return 0;
  const db = await getDb();

  const existingRows = await db
    .select({ id: outreachMessages.id, prospectId: outreachMessages.prospectId })
    .from(outreachMessages)
    .where(
      and(
        inArray(
          outreachMessages.prospectId,
          items.map((item) => item.prospectId)
        ),
        eq(outreachMessages.channel, channel),
        eq(outreachMessages.stepIndex, 0)
      )
    );
  const existingByProspect = new Map<string, string>();
  for (const row of existingRows) {
    if (!existingByProspect.has(row.prospectId)) {
      existingByProspect.set(row.prospectId, row.id);
    }
  }

  const updates: SQL[] = [];
  const inserts: Array<typeof outreachMessages.$inferInsert> = [];
  for (const { prospectId, draft } of items) {
    const existingId = existingByProspect.get(prospectId);
    if (existingId) {
      updates.push(
        sql`(${existingId}::uuid, ${draft.subject}::text, ${draft.body}::text)`
      );
    } else {
      inserts.push({
        prospectId,
        channel,
        subject: draft.subject,
        body: draft.body,
        status: "generated",
        stepIndex: 0,
        parentMessageId: null,
        scheduledFor: null,
      });
    }
  }

  const updatedAt = new Date();
  await runAtomicWrite(db, (tx) => {
    const statements: AtomicStatement[] = [];
    if (inserts.length) {
      statements.push(tx.insert(outreachMessages).values(inserts));
    }
    if (updates.length) {
      // parent_message_id and scheduled_for are left alone: the per-row form kept the
      // existing values when no options were passed.
      statements.push(
        tx.execute(sql`
          UPDATE outreach_messages AS m
             SET subject = v.subject,
                 body = v.body,
                 status = 'generated',
                 updated_at = ${updatedAt}
            FROM (VALUES ${sql.join(updates, sql`, `)}) AS v(id, subject, body)
           WHERE m.id = v.id
        `)
      );
    }
    return statements;
  });

  return items.length;
}

function isLowSignalProspect(
  prospect: {
    title: string | null;
    company: string | null;
    email: string | null;
    phone: string | null;
    linkedinUrl: string | null;
  },
  channel: OutreachChannel
) {
  const hasIdentity = Boolean(prospect.title?.trim() || prospect.company?.trim());
  if (!hasIdentity) return true;
  if (channel === "email") return !prospect.email;
  if (channel === "sms") return !prospect.phone;
  return !prospect.linkedinUrl;
}

export async function generateOutreachDrafts(input: {
  campaignId: string;
  prospectIds?: string[];
  channel?: OutreachChannel;
  templateSeed?: string;
  excludeLowSignal?: boolean;
}) {
  const userId = await requireOutreachUser();
  const campaign = await requireCampaign(userId, input.campaignId);
  const db = await getDb();
  const goals = await listActiveGoalTexts();
  const writingInstructions = await loadWritingInstructions(userId);

  const channel = (input.channel ||
    campaign.defaultChannel ||
    "email") as OutreachChannel;

  const prospects = await db.query.outreachProspects.findMany({
    where: and(
      eq(outreachProspects.campaignId, input.campaignId),
      input.prospectIds?.length
        ? inArray(outreachProspects.id, input.prospectIds)
        : eq(outreachProspects.status, "selected")
    ),
  });

  let targetProspects = prospects.length
    ? prospects
    : await db.query.outreachProspects.findMany({
        where: and(
          eq(outreachProspects.campaignId, input.campaignId),
          inArray(outreachProspects.status, ["selected", "suggested"])
        ),
      });

  if (input.excludeLowSignal !== false) {
    const strong = targetProspects.filter(
      (p) => !isLowSignalProspect(p, channel)
    );
    if (strong.length) targetProspects = strong;
  }

  if (!targetProspects.length) {
    throw new Error("No prospects selected for draft generation.");
  }

  const priorNotesByContact = await priorNotesForContacts(
    userId,
    targetProspects
      .map((p) => p.contactId)
      .filter((id): id is string => Boolean(id))
  );

  const draftInputs = await Promise.all(
    targetProspects.map(async (prospect, index) => ({
      channel,
      tone: campaign.tone || "professional",
      messageIntent:
        campaign.messageIntent || campaign.audienceQuery || "Introduce myself",
      audienceQuery: campaign.audienceQuery,
      replyCta: campaign.replyCta,
      userGoals: goals,
      prospect: {
        fullName: prospect.fullName,
        title: prospect.title,
        company: prospect.company,
        location: prospect.location,
        enrichmentSummary: enrichmentSummary(prospect.enrichment),
        priorNotes: prospect.contactId
          ? (priorNotesByContact.get(prospect.contactId) ?? null)
          : null,
      },
      templateSeed: input.templateSeed,
      variationHint: `Variant ${index + 1} of ${targetProspects.length}`,
      writingInstructions,
    }))
  );

  const drafts = await generateOutreachDraftsBatch(userId, draftInputs);

  const generated = await upsertFirstStepMessages(
    targetProspects.map((prospect, i) => ({
      prospectId: prospect.id,
      draft: drafts[i],
    })),
    channel
  );

  await db
    .update(outreachCampaigns)
    .set({ defaultChannel: channel, updatedAt: new Date() })
    .where(eq(outreachCampaigns.id, input.campaignId));

  revalidatePath(`/outreach/${input.campaignId}`);
  return { generated };
}

export async function regenerateOutreachDraft(input: {
  campaignId: string;
  prospectId: string;
  channel?: OutreachChannel;
  stepIndex?: number;
}) {
  const userId = await requireOutreachUser();
  const campaign = await requireCampaign(userId, input.campaignId);
  const db = await getDb();
  const goals = await listActiveGoalTexts();
  const writingInstructions = await loadWritingInstructions(userId);

  const prospect = await db.query.outreachProspects.findFirst({
    where: and(
      eq(outreachProspects.id, input.prospectId),
      eq(outreachProspects.campaignId, input.campaignId)
    ),
    with: {
      messages: {
        orderBy: [desc(outreachMessages.stepIndex)],
      },
    },
  });
  if (!prospect) throw new Error("Prospect not found");

  const channel = (input.channel ||
    campaign.defaultChannel ||
    "email") as OutreachChannel;
  const stepIndex = input.stepIndex ?? 0;
  const previous = prospect.messages.find(
    (m) => (m.stepIndex ?? 0) === stepIndex - 1
  );

  const draft = await generateOutreachDraft(userId, {
    channel,
    tone: campaign.tone || "professional",
    messageIntent:
      campaign.messageIntent || campaign.audienceQuery || "Introduce myself",
    audienceQuery: campaign.audienceQuery,
    replyCta: campaign.replyCta,
    userGoals: goals,
    prospect: {
      fullName: prospect.fullName,
      title: prospect.title,
      company: prospect.company,
      location: prospect.location,
      enrichmentSummary: enrichmentSummary(prospect.enrichment),
      priorNotes: await priorNotesForContact(userId, prospect.contactId),
    },
    stepIndex,
    previousBody: previous?.body,
    writingInstructions,
  });

  const message = await upsertMessageForProspect(prospect.id, channel, draft, {
    stepIndex,
    parentMessageId: previous?.id ?? null,
  });
  revalidatePath(`/outreach/${input.campaignId}`);
  return message;
}

export async function updateOutreachMessage(input: {
  messageId: string;
  subject?: string | null;
  body?: string;
}) {
  const userId = await requireOutreachUser();
  const db = await getDb();

  const message = await db.query.outreachMessages.findFirst({
    where: eq(outreachMessages.id, input.messageId),
    with: {
      prospect: {
        with: { campaign: true },
      },
    },
  });

  if (!message || message.prospect.campaign.userId !== userId) {
    throw new Error("Message not found");
  }

  const [updated] = await db
    .update(outreachMessages)
    .set({
      subject: input.subject ?? message.subject,
      body: input.body ?? message.body,
      updatedAt: new Date(),
    })
    .where(eq(outreachMessages.id, input.messageId))
    .returning();

  revalidatePath(`/outreach/${message.prospect.campaignId}`);
  return updated;
}

async function maybeLogOutreachInteraction(
  prospect: {
    contactId: string | null;
    campaignId: string;
  },
  channel: OutreachChannel,
  body: string,
  action: string
) {
  if (!prospect.contactId) return;

  await logInteraction({
    contactId: prospect.contactId,
    interactionType: "outreach",
    source: `outreach:${channel}`,
    rawNotes: body,
    aiSummary: `Outreach ${action} via ${channel} (campaign ${prospect.campaignId})`,
  });
}

export async function markMessageAction(input: {
  messageId: string;
  status: Extract<OutreachMessageStatus, "copied" | "opened">;
}) {
  const userId = await requireOutreachUser();
  const db = await getDb();

  const message = await db.query.outreachMessages.findFirst({
    where: eq(outreachMessages.id, input.messageId),
    with: {
      prospect: {
        with: { campaign: true },
      },
    },
  });

  if (!message || message.prospect.campaign.userId !== userId) {
    throw new Error("Message not found");
  }

  const now = new Date();
  const [updated] = await db
    .update(outreachMessages)
    .set({
      status: input.status,
      lastActionAt: now,
      updatedAt: now,
      ...(input.status === "opened" && !message.sentAt ? { sentAt: now } : {}),
    })
    .where(eq(outreachMessages.id, input.messageId))
    .returning();

  if (input.status === "opened") {
    await db
      .update(outreachProspects)
      .set({ status: "contacted", updatedAt: now })
      .where(eq(outreachProspects.id, message.prospectId));

    await maybeLogOutreachInteraction(
      {
        contactId: message.prospect.contactId,
        campaignId: message.prospect.campaignId,
      },
      message.channel as OutreachChannel,
      message.body,
      input.status
    );

    await scheduleNextFollowUpIfNeeded({
      campaignId: message.prospect.campaignId,
      prospectId: message.prospectId,
      parentMessage: updated,
    });
  }

  revalidatePath(`/outreach/${message.prospect.campaignId}`);
  revalidatePath("/outreach");
  return updated;
}

export async function logMessageOutcome(input: {
  messageId: string;
  outcome: OutreachMessageOutcome;
  notes?: string | null;
}) {
  const userId = await requireOutreachUser();
  const db = await getDb();

  const message = await db.query.outreachMessages.findFirst({
    where: eq(outreachMessages.id, input.messageId),
    with: {
      prospect: {
        with: { campaign: true },
      },
    },
  });

  if (!message || message.prospect.campaign.userId !== userId) {
    throw new Error("Message not found");
  }

  const now = new Date();
  const [updated] = await db
    .update(outreachMessages)
    .set({
      outcome: input.outcome,
      outcomeNotes: input.notes?.trim() || null,
      repliedAt: now,
      lastActionAt: now,
      updatedAt: now,
    })
    .where(eq(outreachMessages.id, input.messageId))
    .returning();

  let prospectStatus: string = message.prospect.status;
  if (input.outcome === "positive_reply") {
    prospectStatus = "interested";
  } else if (
    input.outcome === "negative_reply" ||
    input.outcome === "unsubscribed"
  ) {
    prospectStatus = "not_interested";
  } else if (input.outcome === "neutral_reply") {
    prospectStatus = "replied";
  } else if (input.outcome === "bounced") {
    prospectStatus = message.prospect.status;
  }

  await db
    .update(outreachProspects)
    .set({ status: prospectStatus, updatedAt: now })
    .where(eq(outreachProspects.id, message.prospectId));

  // Cancel pending follow-ups once we have a reply or bounce/unsubscribe
  if (input.outcome !== "bounced") {
    await db
      .update(outreachMessages)
      .set({ status: "skipped", updatedAt: now })
      .where(
        and(
          eq(outreachMessages.prospectId, message.prospectId),
          eq(outreachMessages.status, "scheduled")
        )
      );
  }

  await maybeLogOutreachInteraction(
    {
      contactId: message.prospect.contactId,
      campaignId: message.prospect.campaignId,
    },
    message.channel as OutreachChannel,
    input.notes?.trim() || `Outcome: ${input.outcome}`,
    input.outcome
  );

  revalidatePath(`/outreach/${message.prospect.campaignId}`);
  revalidatePath("/outreach");
  revalidatePath("/dashboard");
  return updated;
}

async function scheduleNextFollowUpIfNeeded(input: {
  campaignId: string;
  prospectId: string;
  parentMessage: {
    id: string;
    channel: string;
    stepIndex: number | null;
    sentAt: Date | null;
  };
}) {
  const db = await getDb();
  const campaign = await db.query.outreachCampaigns.findFirst({
    where: eq(outreachCampaigns.id, input.campaignId),
  });
  if (!campaign) return;

  const steps = (campaign.sequenceSteps ?? []) as SequenceStep[];
  if (!steps.length) return;

  const currentStep = input.parentMessage.stepIndex ?? 0;
  const nextStepIndex = currentStep + 1;
  const nextStep = steps[nextStepIndex - 1];
  if (!nextStep) return;

  const existing = await db.query.outreachMessages.findFirst({
    where: and(
      eq(outreachMessages.prospectId, input.prospectId),
      eq(outreachMessages.stepIndex, nextStepIndex)
    ),
  });
  if (existing) return;

  const base = input.parentMessage.sentAt
    ? new Date(input.parentMessage.sentAt)
    : new Date();
  const scheduledFor = new Date(base);
  scheduledFor.setDate(scheduledFor.getDate() + (nextStep.delayDays || 3));

  await db.insert(outreachMessages).values({
    prospectId: input.prospectId,
    channel: input.parentMessage.channel,
    subject: null,
    body: "",
    status: "scheduled",
    stepIndex: nextStepIndex,
    parentMessageId: input.parentMessage.id,
    scheduledFor,
  });
}

export async function generateDueFollowUps(campaignId: string) {
  const userId = await requireOutreachUser();
  const campaign = await requireCampaign(userId, campaignId);
  const db = await getDb();
  const goals = await listActiveGoalTexts();
  const writingInstructions = await loadWritingInstructions(userId);
  const now = new Date();

  const campaignProspectIds = await db.query.outreachProspects.findMany({
    where: eq(outreachProspects.campaignId, campaignId),
    columns: { id: true },
  });

  const due = campaignProspectIds.length
    ? await db.query.outreachMessages.findMany({
        where: and(
          eq(outreachMessages.status, "scheduled"),
          lte(outreachMessages.scheduledFor, now),
          inArray(
            outreachMessages.prospectId,
            campaignProspectIds.map((p) => p.id)
          )
        ),
        with: {
          prospect: true,
        },
      })
    : [];

  // Kept as a defensive no-op check, cheap insurance against the `with: { prospect }`
  // join ever returning a row outside the campaign-scoped prospect id set above.
  const dueForCampaign = due.filter((m) => m.prospect.campaignId === campaignId);
  let generated = 0;

  // Everything the loop below reads, read once up front instead of per due message. The
  // loop only writes status/subject/body — never `outcome` or interactions — so the one
  // thing it can change is a parent's body; `parentBodies` is kept current so a step whose
  // parent was generated earlier in this same pass still sees that new body.
  const dueProspectIds = [...new Set(dueForCampaign.map((m) => m.prospectId))];
  const parentIds = [
    ...new Set(
      dueForCampaign
        .map((m) => m.parentMessageId)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const [repliedRows, parentRows, priorNotesByContact] = await Promise.all([
    dueProspectIds.length
      ? db
          .selectDistinct({ prospectId: outreachMessages.prospectId })
          .from(outreachMessages)
          .where(
            and(
              inArray(outreachMessages.prospectId, dueProspectIds),
              sql`${outreachMessages.outcome} is not null`
            )
          )
      : [],
    parentIds.length
      ? db
          .select({ id: outreachMessages.id, body: outreachMessages.body })
          .from(outreachMessages)
          .where(inArray(outreachMessages.id, parentIds))
      : [],
    priorNotesForContacts(userId, [
      ...new Set(
        dueForCampaign
          .map((m) => m.prospect.contactId)
          .filter((id): id is string => Boolean(id))
      ),
    ]),
  ]);
  const repliedProspects = new Set(repliedRows.map((row) => row.prospectId));
  const parentBodies = new Map(parentRows.map((row) => [row.id, row.body]));

  const skippedIds: string[] = [];
  const toGenerate: typeof dueForCampaign = [];
  for (const message of dueForCampaign) {
    if (
      message.prospect.status === "interested" ||
      message.prospect.status === "not_interested" ||
      message.prospect.status === "replied" ||
      repliedProspects.has(message.prospectId)
    ) {
      skippedIds.push(message.id);
    } else {
      toGenerate.push(message);
    }
  }

  // Decided entirely from the reads above, so one statement before the model calls
  // rather than one per skipped message inside the loop.
  if (skippedIds.length) {
    await db
      .update(outreachMessages)
      .set({ status: "skipped", updatedAt: now })
      .where(inArray(outreachMessages.id, skippedIds));
  }

  for (const message of toGenerate) {
    const steps = (campaign.sequenceSteps ?? []) as SequenceStep[];
    const step = steps[(message.stepIndex ?? 1) - 1];
    const channel = message.channel as OutreachChannel;

    const draft = await generateOutreachDraft(userId, {
      channel,
      tone: campaign.tone || "professional",
      messageIntent:
        step?.intent ||
        campaign.messageIntent ||
        campaign.audienceQuery ||
        "Follow up",
      audienceQuery: campaign.audienceQuery,
      replyCta: campaign.replyCta,
      userGoals: goals,
      prospect: {
        fullName: message.prospect.fullName,
        title: message.prospect.title,
        company: message.prospect.company,
        location: message.prospect.location,
        enrichmentSummary: enrichmentSummary(message.prospect.enrichment),
        priorNotes: message.prospect.contactId
          ? (priorNotesByContact.get(message.prospect.contactId) ?? null)
          : null,
      },
      stepIndex: message.stepIndex ?? 1,
      previousBody: message.parentMessageId
        ? parentBodies.get(message.parentMessageId)
        : undefined,
      writingInstructions,
    });

    await db
      .update(outreachMessages)
      .set({
        subject: draft.subject,
        body: draft.body,
        status: "generated",
        updatedAt: now,
      })
      .where(eq(outreachMessages.id, message.id));
    if (parentBodies.has(message.id)) parentBodies.set(message.id, draft.body);
    generated += 1;
  }

  revalidatePath(`/outreach/${campaignId}`);
  return { generated };
}

/**
 * Returns the refusal as data: a thrown message is a digest in production, and "this is a
 * sample prospect" is exactly the sentence the person needs to read.
 */
export async function sendOutreachMessageAction(messageId: string) {
  return asActionResult(() => sendOutreachMessageNow(messageId));
}

/** The send itself. Throws; `bulkSendOutreach` catches per message. */
async function sendOutreachMessageNow(messageId: string) {
  const userId = await requireOutreachUser();
  const db = await getDb();

  const message = await db.query.outreachMessages.findFirst({
    where: eq(outreachMessages.id, messageId),
    with: {
      prospect: {
        with: { campaign: true },
      },
    },
  });

  if (!message || message.prospect.campaign.userId !== userId) {
    throw new Error("Message not found");
  }

  // Before anything else, and outside the try below: a refusal is not a failed send, so
  // the draft must not be marked "failed".
  if (isDemoProspect(message.prospect.enrichment)) {
    throw new UserFacingError(DEMO_PROSPECT_SEND_MESSAGE);
  }

  const quality = assessOutreachQuality([
    {
      messageId: message.id,
      prospectId: message.prospectId,
      prospectName: message.prospect.fullName,
      channel: message.channel as OutreachChannel,
      subject: message.subject,
      body: message.body,
      isDemo: false,
    },
  ]);
  if (quality.blocking.length) {
    // Deliberate wording, so `friendlyError` lets it through where it is caught on the
    // server — the per-message loop in `bulkSendOutreach`.
    throw new UserFacingError(quality.blocking[0].message);
  }

  const channel = message.channel as OutreachChannel;
  const now = new Date();

  try {
    const result = await sendOutreachMessage({
      userId,
      channel,
      toEmail: message.prospect.email,
      toPhone: message.prospect.phone,
      subject: message.subject,
      body: message.body,
    });

    const [updated] = await db
      .update(outreachMessages)
      .set({
        status: "sent",
        sentAt: now,
        lastActionAt: now,
        deliveryId: result.deliveryId,
        errorMessage: null,
        updatedAt: now,
      })
      .where(eq(outreachMessages.id, messageId))
      .returning();

    await db
      .update(outreachProspects)
      .set({ status: "contacted", updatedAt: now })
      .where(eq(outreachProspects.id, message.prospectId));

    await maybeLogOutreachInteraction(
      {
        contactId: message.prospect.contactId,
        campaignId: message.prospect.campaignId,
      },
      channel,
      message.body,
      "sent"
    );

    await scheduleNextFollowUpIfNeeded({
      campaignId: message.prospect.campaignId,
      prospectId: message.prospectId,
      parentMessage: updated,
    });

    revalidatePath(`/outreach/${message.prospect.campaignId}`);
    revalidatePath("/outreach");
    return updated;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Send failed";
    await db
      .update(outreachMessages)
      .set({
        status: "failed",
        errorMessage,
        lastActionAt: now,
        updatedAt: now,
      })
      .where(eq(outreachMessages.id, messageId));
    throw err;
  }
}

/**
 * The requested messages that belong to this campaign — and so, because the campaign was
 * already checked against the caller, to this user. An id from anywhere else is dropped
 * silently rather than refused, so the answer cannot confirm that a guessed id exists.
 */
async function campaignMessages(campaignId: string, messageIds: string[]) {
  if (messageIds.length === 0) return [];
  const db = await getDb();
  return db.query.outreachMessages.findMany({
    where: and(
      inArray(outreachMessages.id, messageIds),
      inArray(
        outreachMessages.prospectId,
        db
          .select({ id: outreachProspects.id })
          .from(outreachProspects)
          .where(eq(outreachProspects.campaignId, campaignId))
      )
    ),
    with: { prospect: true },
  });
}

export async function previewBulkSendQuality(input: {
  campaignId: string;
  messageIds: string[];
}) {
  const userId = await requireOutreachUser();
  await requireCampaign(userId, input.campaignId);

  const messages = await campaignMessages(input.campaignId, input.messageIds);

  return assessOutreachQuality(
    messages.map((m) => ({
      messageId: m.id,
      prospectId: m.prospectId,
      prospectName: m.prospect.fullName,
      channel: m.channel as OutreachChannel,
      subject: m.subject,
      body: m.body,
      isDemo: isDemoProspect(m.prospect.enrichment),
    }))
  );
}

export async function bulkSendOutreach(input: {
  campaignId: string;
  messageIds: string[];
  ignoreWarnings?: boolean;
}) {
  const userId = await requireOutreachUser();
  await requireCampaign(userId, input.campaignId);

  const quality = await previewBulkSendQuality({
    campaignId: input.campaignId,
    messageIds: input.messageIds,
  });
  // Both outcomes come back as data. They used to be thrown, and a thrown message is a
  // digest in production — so the client's `startsWith("Quality warnings:")` check could
  // never match there, and a blocked send never said why. The dialog pre-checks quality
  // through `previewBulkSendQuality`, so these are the safety net for drafts that
  // changed in between; a safety net that says nothing is not one.
  if (quality.blocking.length) {
    const more =
      quality.blocking.length > 1 ? ` (and ${quality.blocking.length - 1} more)` : "";
    return {
      status: "blocked" as const,
      reason: `Can’t send yet — ${quality.blocking[0].message}${more}`,
    };
  }
  if (!input.ignoreWarnings && quality.warnings.length) {
    return {
      status: "needs_confirmation" as const,
      warning: quality.warnings[0].message,
    };
  }

  // Same scope as the preview above: only this campaign's messages are ever sent from here.
  const inCampaign = new Set(
    (await campaignMessages(input.campaignId, input.messageIds)).map((m) => m.id)
  );
  const ids = input.messageIds.filter((id) => inCampaign.has(id)).slice(0, BULK_SEND_LIMIT);
  const results: Array<{ messageId: string; ok: boolean; error?: string }> = [];

  for (const messageId of ids) {
    try {
      await sendOutreachMessageNow(messageId);
      results.push({ messageId, ok: true });
    } catch (err) {
      results.push({
        messageId,
        ok: false,
        error: await actionFailure(err, TOAST_COPY.sendFailed, "outreach.bulk-send", { messageId }),
      });
    }
  }

  revalidatePath(`/outreach/${input.campaignId}`);
  revalidatePath("/outreach");
  return {
    status: "sent" as const,
    sent: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
    quality,
  };
}

export async function saveProspectAsContact(input: {
  campaignId: string;
  prospectId: string;
}) {
  const userId = await requireOutreachUser();
  await requireCampaign(userId, input.campaignId);
  const db = await getDb();

  const prospect = await db.query.outreachProspects.findFirst({
    where: and(
      eq(outreachProspects.id, input.prospectId),
      eq(outreachProspects.campaignId, input.campaignId)
    ),
  });
  if (!prospect) throw new Error("Prospect not found");
  if (prospect.contactId) return { contactId: prospect.contactId, created: false };

  // A sample's email, phone and profile URL were made up: never copy them into the network.
  const demo = isDemoProspect(prospect.enrichment);
  let email = demo ? null : prospect.email;
  let phone = demo ? null : prospect.phone;

  if (!demo && (!email || !phone)) {
    const enriched = await enrichPerson(userId, prospect.externalId, {
      email: prospect.email ?? undefined,
      linkedinUrl: prospect.linkedinUrl ?? undefined,
      fullName: prospect.fullName,
    });
    if (enriched) {
      email = email || enriched.email;
      phone = phone || enriched.phone;
    }
  }

  const contact = await createContact(
    {
      fullName: prospect.fullName,
      title: prospect.title ?? undefined,
      company: prospect.company ?? undefined,
      location: prospect.location ?? undefined,
      email: email ?? undefined,
      phone: phone ?? undefined,
      linkedinUrl: demo ? undefined : (prospect.linkedinUrl ?? undefined),
      source: "outreach",
      notes: `Added from outreach campaign ${input.campaignId}`,
    },
    { skipRevalidate: true }
  );

  await db
    .update(outreachProspects)
    .set({
      contactId: contact.id,
      email: email ?? prospect.email,
      phone: phone ?? prospect.phone,
      updatedAt: new Date(),
    })
    .where(eq(outreachProspects.id, prospect.id));

  revalidatePath(`/outreach/${input.campaignId}`);
  revalidatePath("/contacts");
  return { contactId: contact.id, created: true };
}

export async function enrichProspect(input: {
  campaignId: string;
  prospectId: string;
}) {
  const userId = await requireOutreachUser();
  await requireCampaign(userId, input.campaignId);
  const db = await getDb();

  const prospect = await db.query.outreachProspects.findFirst({
    where: and(
      eq(outreachProspects.id, input.prospectId),
      eq(outreachProspects.campaignId, input.campaignId)
    ),
  });
  if (!prospect) throw new Error("Prospect not found");

  const enriched = await enrichPerson(userId, prospect.externalId, {
    email: prospect.email ?? undefined,
    linkedinUrl: prospect.linkedinUrl ?? undefined,
    fullName: prospect.fullName,
  });

  if (!enriched) return prospect;

  const [updated] = await db
    .update(outreachProspects)
    .set({
      email: enriched.email ?? prospect.email,
      phone: enriched.phone ?? prospect.phone,
      linkedinUrl: enriched.linkedinUrl ?? prospect.linkedinUrl,
      title: enriched.title ?? prospect.title,
      company: enriched.company ?? prospect.company,
      location: enriched.location ?? prospect.location,
      enrichment: enriched.enrichment,
      updatedAt: new Date(),
    })
    .where(eq(outreachProspects.id, prospect.id))
    .returning();

  revalidatePath(`/outreach/${input.campaignId}`);
  return updated;
}
