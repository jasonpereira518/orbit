"use server";

import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
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
  enrichPerson,
  parseAudienceToFilters,
  searchPeople,
} from "@/lib/apollo";
import { requireUserId } from "@/lib/auth";
import {
  computeCampaignMetrics,
  computeChannelBreakdown,
  computeStepBreakdown,
} from "@/lib/outreach-metrics";
import {
  generateOutreachDraft,
  generateOutreachDraftsBatch,
} from "@/lib/outreach-drafts";
import { assessOutreachQuality } from "@/lib/outreach-quality";
import { sendOutreachMessage } from "@/lib/outreach-send";
import {
  BULK_SEND_LIMIT,
  type OutreachChannel,
  type OutreachMessageOutcome,
  type OutreachMessageStatus,
  type SequenceStep,
} from "@/lib/outreach-types";

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

async function priorNotesForContact(contactId: string | null) {
  if (!contactId) return null;
  const db = await getDb();
  const rows = await db.query.interactions.findMany({
    where: eq(interactions.contactId, contactId),
    orderBy: [desc(interactions.interactionDate)],
    limit: 3,
  });
  if (!rows.length) return null;
  return rows
    .map((row) => row.aiSummary || row.rawNotes)
    .filter(Boolean)
    .join(" | ")
    .slice(0, 500);
}

export async function listCampaigns() {
  const userId = await requireUserId();
  const db = await getDb();
  const campaigns = await db.query.outreachCampaigns.findMany({
    where: eq(outreachCampaigns.userId, userId),
    orderBy: [desc(outreachCampaigns.updatedAt)],
    with: {
      prospects: {
        columns: { id: true, status: true },
        with: {
          messages: {
            columns: {
              id: true,
              status: true,
              outcome: true,
              stepIndex: true,
              channel: true,
              sentAt: true,
              scheduledFor: true,
              repliedAt: true,
            },
          },
        },
      },
    },
  });

  return campaigns.map((campaign) => ({
    ...campaign,
    metrics: computeCampaignMetrics(campaign.prospects),
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
  const campaigns = await listCampaigns();
  const ranked = [...campaigns]
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

  const totals = campaigns.reduce(
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
  const userId = await requireUserId();
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
  const userId = await requireUserId();
  await requireCampaign(userId, campaignId);
  const db = await getDb();

  const { reparseAudience, sequenceSteps, ...fields } = input;
  const patch: Record<string, unknown> = {
    ...fields,
    updatedAt: new Date(),
  };

  if (sequenceSteps !== undefined) {
    patch.sequenceSteps = sequenceSteps as OutreachSequenceStep[];
  }

  if (fields.audienceQuery !== undefined && reparseAudience !== false) {
    patch.audienceFilters = fields.audienceQuery.trim()
      ? await parseAudienceToFilters(userId, fields.audienceQuery)
      : {};
  }

  const [updated] = await db
    .update(outreachCampaigns)
    .set(patch)
    .where(eq(outreachCampaigns.id, campaignId))
    .returning();

  revalidatePath("/outreach");
  revalidatePath(`/outreach/${campaignId}`);
  return updated;
}

export async function searchProspects(campaignId: string, page = 1) {
  const userId = await requireUserId();
  const campaign = await requireCampaign(userId, campaignId);
  const db = await getDb();

  const filters = (campaign.audienceFilters ?? {}) as AudienceFilters;
  const { prospects, total } = await searchPeople(userId, filters, page);

  for (const prospect of prospects) {
    await db
      .insert(outreachProspects)
      .values({
        campaignId,
        externalId: prospect.externalId,
        fullName: prospect.fullName,
        title: prospect.title,
        company: prospect.company,
        email: prospect.email,
        phone: prospect.phone,
        linkedinUrl: prospect.linkedinUrl,
        location: prospect.location,
        enrichment: prospect.enrichment,
        status: "selected",
      })
      .onConflictDoUpdate({
        target: [outreachProspects.campaignId, outreachProspects.externalId],
        set: {
          fullName: prospect.fullName,
          title: prospect.title,
          company: prospect.company,
          email: prospect.email,
          phone: prospect.phone,
          linkedinUrl: prospect.linkedinUrl,
          location: prospect.location,
          enrichment: prospect.enrichment,
          updatedAt: new Date(),
        },
      });
  }

  await db
    .update(outreachCampaigns)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq(outreachCampaigns.id, campaignId));

  revalidatePath(`/outreach/${campaignId}`);
  return { imported: prospects.length, total };
}

export async function updateProspectSelection(input: {
  campaignId: string;
  prospectIds: string[];
  status: "selected" | "excluded" | "suggested";
}) {
  const userId = await requireUserId();
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
  const userId = await requireUserId();
  const campaign = await requireCampaign(userId, input.campaignId);
  const db = await getDb();
  const goals = await listActiveGoalTexts(userId);

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

  const draftInputs = await Promise.all(
    targetProspects.map(async (prospect, index) => ({
      channel,
      tone: campaign.tone || "professional",
      messageIntent:
        campaign.messageIntent || campaign.audienceQuery || "Introduce myself",
      replyCta: campaign.replyCta,
      userGoals: goals,
      prospect: {
        fullName: prospect.fullName,
        title: prospect.title,
        company: prospect.company,
        location: prospect.location,
        enrichmentSummary: enrichmentSummary(prospect.enrichment),
        priorNotes: await priorNotesForContact(prospect.contactId),
      },
      templateSeed: input.templateSeed,
      variationHint: `Variant ${index + 1} of ${targetProspects.length}`,
    }))
  );

  const drafts = await generateOutreachDraftsBatch(userId, draftInputs);

  const messages = [];
  for (let i = 0; i < targetProspects.length; i++) {
    messages.push(
      await upsertMessageForProspect(targetProspects[i].id, channel, drafts[i])
    );
  }

  await db
    .update(outreachCampaigns)
    .set({ defaultChannel: channel, updatedAt: new Date() })
    .where(eq(outreachCampaigns.id, input.campaignId));

  revalidatePath(`/outreach/${input.campaignId}`);
  return { generated: messages.length };
}

export async function regenerateOutreachDraft(input: {
  campaignId: string;
  prospectId: string;
  channel?: OutreachChannel;
  stepIndex?: number;
}) {
  const userId = await requireUserId();
  const campaign = await requireCampaign(userId, input.campaignId);
  const db = await getDb();
  const goals = await listActiveGoalTexts(userId);

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
    replyCta: campaign.replyCta,
    userGoals: goals,
    prospect: {
      fullName: prospect.fullName,
      title: prospect.title,
      company: prospect.company,
      location: prospect.location,
      enrichmentSummary: enrichmentSummary(prospect.enrichment),
      priorNotes: await priorNotesForContact(prospect.contactId),
    },
    stepIndex,
    previousBody: previous?.body,
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
  const userId = await requireUserId();
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
  const userId = await requireUserId();
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
  const userId = await requireUserId();
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
  const userId = await requireUserId();
  const campaign = await requireCampaign(userId, campaignId);
  const db = await getDb();
  const goals = await listActiveGoalTexts(userId);
  const now = new Date();

  const due = await db.query.outreachMessages.findMany({
    where: and(
      eq(outreachMessages.status, "scheduled"),
      lte(outreachMessages.scheduledFor, now)
    ),
    with: {
      prospect: true,
    },
  });

  const dueForCampaign = due.filter((m) => m.prospect.campaignId === campaignId);
  let generated = 0;

  for (const message of dueForCampaign) {
    if (message.prospect.status === "interested" || message.prospect.status === "not_interested" || message.prospect.status === "replied") {
      await db
        .update(outreachMessages)
        .set({ status: "skipped", updatedAt: now })
        .where(eq(outreachMessages.id, message.id));
      continue;
    }

    const replied = await db.query.outreachMessages.findFirst({
      where: and(
        eq(outreachMessages.prospectId, message.prospectId),
        sql`${outreachMessages.outcome} is not null`
      ),
    });
    if (replied) {
      await db
        .update(outreachMessages)
        .set({ status: "skipped", updatedAt: now })
        .where(eq(outreachMessages.id, message.id));
      continue;
    }

    const parent = message.parentMessageId
      ? await db.query.outreachMessages.findFirst({
          where: eq(outreachMessages.id, message.parentMessageId),
        })
      : null;

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
      replyCta: campaign.replyCta,
      userGoals: goals,
      prospect: {
        fullName: message.prospect.fullName,
        title: message.prospect.title,
        company: message.prospect.company,
        location: message.prospect.location,
        enrichmentSummary: enrichmentSummary(message.prospect.enrichment),
        priorNotes: await priorNotesForContact(message.prospect.contactId),
      },
      stepIndex: message.stepIndex ?? 1,
      previousBody: parent?.body,
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
    generated += 1;
  }

  revalidatePath(`/outreach/${campaignId}`);
  return { generated };
}

export async function sendOutreachMessageAction(messageId: string) {
  const userId = await requireUserId();
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

  const quality = assessOutreachQuality([
    {
      messageId: message.id,
      prospectId: message.prospectId,
      prospectName: message.prospect.fullName,
      channel: message.channel as OutreachChannel,
      subject: message.subject,
      body: message.body,
    },
  ]);
  if (quality.blocking.length) {
    throw new Error(quality.blocking[0].message);
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

export async function previewBulkSendQuality(input: {
  campaignId: string;
  messageIds: string[];
}) {
  const userId = await requireUserId();
  await requireCampaign(userId, input.campaignId);
  const db = await getDb();

  const messages = await db.query.outreachMessages.findMany({
    where: inArray(outreachMessages.id, input.messageIds),
    with: { prospect: true },
  });

  return assessOutreachQuality(
    messages.map((m) => ({
      messageId: m.id,
      prospectId: m.prospectId,
      prospectName: m.prospect.fullName,
      channel: m.channel as OutreachChannel,
      subject: m.subject,
      body: m.body,
    }))
  );
}

export async function bulkSendOutreach(input: {
  campaignId: string;
  messageIds: string[];
  ignoreWarnings?: boolean;
}) {
  const userId = await requireUserId();
  await requireCampaign(userId, input.campaignId);

  const quality = await previewBulkSendQuality({
    campaignId: input.campaignId,
    messageIds: input.messageIds,
  });
  if (quality.blocking.length) {
    throw new Error(
      `Cannot send: ${quality.blocking[0].message}${
        quality.blocking.length > 1
          ? ` (+${quality.blocking.length - 1} more)`
          : ""
      }`
    );
  }
  if (!input.ignoreWarnings && quality.warnings.length) {
    throw new Error(
      `Quality warnings: ${quality.warnings[0].message}. Confirm to send anyway.`
    );
  }

  const ids = input.messageIds.slice(0, BULK_SEND_LIMIT);
  const results: Array<{ messageId: string; ok: boolean; error?: string }> = [];

  for (const messageId of ids) {
    try {
      await sendOutreachMessageAction(messageId);
      results.push({ messageId, ok: true });
    } catch (err) {
      results.push({
        messageId,
        ok: false,
        error: err instanceof Error ? err.message : "Send failed",
      });
    }
  }

  revalidatePath(`/outreach/${input.campaignId}`);
  revalidatePath("/outreach");
  return {
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
  const userId = await requireUserId();
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

  let email = prospect.email;
  let phone = prospect.phone;

  if (!email || !phone) {
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
      linkedinUrl: prospect.linkedinUrl ?? undefined,
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
  const userId = await requireUserId();
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
