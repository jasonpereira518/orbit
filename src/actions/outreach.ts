"use server";

import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { outreachCampaigns, outreachMessages, outreachProspects } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { requireOutreachUser } from "@/lib/plan-guards";
import {
  computeCampaignMetrics,
  computeChannelBreakdown,
  computeStepBreakdown,
} from "@/lib/outreach-metrics";
import { campaignMetricAggregates, metricsFromAggregates } from "@/lib/outreach-metrics-sql";
import { setMessageOutcomeForUser } from "@/lib/outreach-replies";
import {
  OUTREACH_CHANNELS,
  OUTREACH_REPLY_CTAS,
  OUTREACH_TONES,
  type OutreachChannel,
  type OutreachReplyCta,
  type OutreachMessageOutcome,
} from "@/lib/outreach-types";
import { asActionResult, UserFacingError } from "@/lib/errors";

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
      const aRate = a.metrics.replyRate ?? -1;
      const bRate = b.metrics.replyRate ?? -1;
      if (bRate !== aRate) return bRate - aRate;
      return b.metrics.replyCount - a.metrics.replyCount;
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
      replyRate: eligible > 0 ? totals.replies / eligible : null,
      campaignCount: campaigns.length,
    },
  };
}

function boundedText(value: unknown, min: number, max: number, tooShort: string, tooLong: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < min) throw new UserFacingError(tooShort);
  if (text.length > max) throw new UserFacingError(tooLong);
  return text;
}

/**
 * Starts a campaign from a description. No model call: the audience text is stored as typed and
 * is the search itself (`discoverPeople`), so creating one costs nothing and cannot fail on a
 * missing AI key. Everything is checked here because this is a public POST endpoint.
 */
export async function createCampaign(input: {
  name?: string;
  audienceQuery: string;
  messageIntent: string;
  replyCta: OutreachReplyCta;
  defaultChannel: "email" | "linkedin";
  tone: (typeof OUTREACH_TONES)[number];
}) {
  return asActionResult(async () => {
    const userId = await requireOutreachUser();

    const audienceQuery = boundedText(
      input.audienceQuery,
      3,
      300,
      "Say who you want to reach, in a few words",
      "Keep who you want to reach under 300 characters"
    );
    const messageIntent = boundedText(
      input.messageIntent,
      3,
      1_000,
      "Say why you’re reaching out, in a few words",
      "Keep why you’re reaching out under 1,000 characters"
    );
    if (!OUTREACH_REPLY_CTAS.includes(input.replyCta)) throw new UserFacingError("Pick what you’re asking for");
    if (input.defaultChannel !== "email" && input.defaultChannel !== "linkedin") {
      throw new UserFacingError("Pick Email or LinkedIn");
    }
    if (!OUTREACH_TONES.includes(input.tone)) throw new UserFacingError("Pick a tone");
    const name =
      (typeof input.name === "string" ? input.name.trim().slice(0, 120) : "") ||
      audienceQuery.replace(/\s+/g, " ").slice(0, 60).trim();

    const db = await getDb();
    const [campaign] = await db
      .insert(outreachCampaigns)
      .values({
        userId,
        name,
        audienceQuery,
        messageIntent,
        replyCta: input.replyCta,
        defaultChannel: input.defaultChannel,
        tone: input.tone,
        status: "draft",
      })
      .returning();

    revalidatePath("/outreach");
    return { id: campaign.id };
  });
}

const CAMPAIGN_TEXT_MAX = 4_000;

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
    messageIntent?: string | null;
    replyCta?: string | null;
    tone?: string;
    defaultChannel?: OutreachChannel;
    status?: string;
  }
) {
  const userId = await requireOutreachUser();
  await requireCampaign(userId, campaignId);
  const db = await getDb();

  // Allowlisted, never spread: every export here is a public POST endpoint, and spreading
  // the argument into `.set()` let a caller write any real column — `userId` included,
  // which moved a campaign and its drafts into another account.
  const fields = pickCampaignFields(input as Record<string, unknown>);
  const patch: Record<string, unknown> = {
    ...fields,
    updatedAt: new Date(),
  };

  const [updated] = await db
    .update(outreachCampaigns)
    .set(patch)
    .where(and(eq(outreachCampaigns.id, campaignId), eq(outreachCampaigns.userId, userId)))
    .returning();

  revalidatePath("/outreach");
  revalidatePath(`/outreach/${campaignId}`);
  return updated;
}

export async function logMessageOutcome(input: {
  messageId: string;
  outcome: OutreachMessageOutcome;
  notes?: string | null;
}) {
  const userId = await requireOutreachUser();
  const campaignId = await setMessageOutcomeForUser(userId, input.messageId, input.outcome, input.notes);
  revalidatePath(`/outreach/${campaignId}`);
  revalidatePath("/outreach");
  revalidatePath("/dashboard");
}
