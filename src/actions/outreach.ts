"use server";

import { and, desc, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  outreachCampaigns,
  outreachMessages,
  outreachProspects,
  type AudienceFilters,
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
  generateOutreachDraft,
  generateOutreachDraftsBatch,
} from "@/lib/outreach-drafts";
import { sendOutreachMessage } from "@/lib/outreach-send";
import {
  BULK_SEND_LIMIT,
  type OutreachChannel,
  type OutreachMessageStatus,
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

export async function listCampaigns() {
  const userId = await requireUserId();
  const db = await getDb();
  return db.query.outreachCampaigns.findMany({
    where: eq(outreachCampaigns.userId, userId),
    orderBy: [desc(outreachCampaigns.updatedAt)],
    with: {
      prospects: {
        columns: { id: true, status: true },
      },
    },
  });
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
  return campaign;
}

export async function createCampaign(input: {
  name: string;
  audienceQuery: string;
  audienceFilters?: AudienceFilters;
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
    tone?: string;
    defaultChannel?: OutreachChannel;
    status?: string;
    reparseAudience?: boolean;
  }
) {
  const userId = await requireUserId();
  await requireCampaign(userId, campaignId);
  const db = await getDb();

  const { reparseAudience, ...fields } = input;
  const patch: Record<string, unknown> = {
    ...fields,
    updatedAt: new Date(),
  };

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
  draft: { subject: string | null; body: string }
) {
  const db = await getDb();
  const existing = await db.query.outreachMessages.findFirst({
    where: and(
      eq(outreachMessages.prospectId, prospectId),
      eq(outreachMessages.channel, channel)
    ),
  });

  if (existing) {
    const [updated] = await db
      .update(outreachMessages)
      .set({
        subject: draft.subject,
        body: draft.body,
        status: "generated",
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
      status: "generated",
    })
    .returning();
  return created;
}

export async function generateOutreachDrafts(input: {
  campaignId: string;
  prospectIds?: string[];
  channel?: OutreachChannel;
  templateSeed?: string;
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

  const targetProspects = prospects.length
    ? prospects
    : await db.query.outreachProspects.findMany({
        where: and(
          eq(outreachProspects.campaignId, input.campaignId),
          inArray(outreachProspects.status, ["selected", "suggested"])
        ),
      });

  if (!targetProspects.length) {
    throw new Error("No prospects selected for draft generation.");
  }

  const drafts = await generateOutreachDraftsBatch(
    userId,
    targetProspects.map((prospect) => ({
      channel,
      tone: campaign.tone || "professional",
      messageIntent: campaign.messageIntent || campaign.audienceQuery || "Introduce myself",
      userGoals: goals,
      prospect: {
        fullName: prospect.fullName,
        title: prospect.title,
        company: prospect.company,
        location: prospect.location,
      },
      templateSeed: input.templateSeed,
    }))
  );

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
  });
  if (!prospect) throw new Error("Prospect not found");

  const channel = (input.channel ||
    campaign.defaultChannel ||
    "email") as OutreachChannel;

  const draft = await generateOutreachDraft(userId, {
    channel,
    tone: campaign.tone || "professional",
    messageIntent: campaign.messageIntent || campaign.audienceQuery || "Introduce myself",
    userGoals: goals,
    prospect: {
      fullName: prospect.fullName,
      title: prospect.title,
      company: prospect.company,
      location: prospect.location,
    },
  });

  const message = await upsertMessageForProspect(prospect.id, channel, draft);
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
  action: OutreachMessageStatus
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
  }

  revalidatePath(`/outreach/${message.prospect.campaignId}`);
  return updated;
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

    revalidatePath(`/outreach/${message.prospect.campaignId}`);
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

export async function bulkSendOutreach(input: {
  campaignId: string;
  messageIds: string[];
}) {
  const userId = await requireUserId();
  await requireCampaign(userId, input.campaignId);

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
  return {
    sent: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
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
