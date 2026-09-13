import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { outreachCampaigns, outreachProspects, userSettings } from "@/db/schema";
import { UserFacingError } from "@/lib/errors";
import { briefSchema, criteriaFromBrief, EMPTY_CRITERIA, hasAnyCriteria, normalizeCriteria } from "@/lib/outreach/criteria";
import { enqueueJob } from "@/lib/outreach/jobs/queue";
import {
  SETUP_STEPS,
  type JsonCompleter,
  type OutreachBrief,
  type OutreachChannel,
  type OutreachCriteria,
  type OutreachSetupStep,
} from "@/lib/outreach/types";
import { ensureUserSettings } from "@/lib/user-settings";

export type CampaignV2 = {
  id: string;
  userId: string;
  name: string;
  status: string;
  brief: OutreachBrief;
  channel: OutreachChannel;
  senderIntro: string | null;
  criteria: OutreachCriteria;
  criteriaVersion: number;
  criteriaConfirmedAt: Date | null;
  setupStep: OutreachSetupStep;
  createdAt: Date;
  updatedAt: Date;
};

export type CampaignListItem = {
  id: string;
  name: string;
  generation: number;
  status: string;
  channel: string | null;
  setupStep: OutreachSetupStep | null;
  updatedAt: Date;
  prospectCount: number;
  selectedCount: number;
};

export function laterStep(current: OutreachSetupStep | null, next: OutreachSetupStep): OutreachSetupStep {
  if (!current) return next;
  return SETUP_STEPS.indexOf(next) > SETUP_STEPS.indexOf(current) ? next : current;
}

function parseBrief(input: unknown): OutreachBrief {
  const parsed = briefSchema.safeParse(input);
  if (!parsed.success) {
    throw new UserFacingError(parsed.error.issues[0]?.message ?? "Describe the campaign a little more");
  }
  return parsed.data;
}

function parseChannel(channel: unknown): OutreachChannel {
  if (channel !== "email" && channel !== "linkedin") throw new UserFacingError("Pick email or LinkedIn for this campaign");
  return channel;
}

function nameFrom(brief: OutreachBrief, name?: string) {
  const explicit = name?.trim();
  if (explicit) return explicit.slice(0, 120);
  return brief.purpose.split(/[.!?\n]/)[0].trim().slice(0, 80) || "Untitled campaign";
}

const scoped = (userId: string, id: string) =>
  and(eq(outreachCampaigns.id, id), eq(outreachCampaigns.userId, userId), eq(outreachCampaigns.generation, 2));

export async function createCampaignV2(
  userId: string,
  input: { name?: string; brief: unknown; channel: OutreachChannel; senderIntro?: string | null; saveIntroAsDefault?: boolean }
): Promise<{ id: string }> {
  const brief = parseBrief(input.brief);
  const channel = parseChannel(input.channel);
  const senderIntro = input.senderIntro?.trim().slice(0, 1000) || null;
  const db = await getDb();
  const [row] = await db
    .insert(outreachCampaigns)
    .values({
      userId,
      name: nameFrom(brief, input.name),
      status: "draft",
      generation: 2,
      brief,
      channel,
      defaultChannel: channel,
      audienceQuery: brief.purpose,
      senderIntro,
      criteria: EMPTY_CRITERIA,
      criteriaVersion: 0,
      setupStep: "audience",
    })
    .returning();
  if (input.saveIntroAsDefault && senderIntro) {
    await ensureUserSettings(userId);
    await db.update(userSettings).set({ outreachSenderIntro: senderIntro }).where(eq(userSettings.userId, userId));
  }
  return { id: row.id };
}

export async function getCampaignV2(userId: string, id: string): Promise<CampaignV2 | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const db = await getDb();
  const [row] = await db.select().from(outreachCampaigns).where(scoped(userId, id));
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    status: row.status,
    brief: row.brief ?? { purpose: row.audienceQuery ?? "", desiredOutcome: "" },
    channel: row.channel ?? "email",
    senderIntro: row.senderIntro,
    criteria: row.criteria ? normalizeCriteria(row.criteria) : EMPTY_CRITERIA,
    criteriaVersion: row.criteriaVersion,
    criteriaConfirmedAt: row.criteriaConfirmedAt,
    setupStep: row.setupStep ?? "audience",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function requireCampaign(userId: string, id: string): Promise<CampaignV2> {
  const campaign = await getCampaignV2(userId, id);
  if (!campaign) throw new UserFacingError("That campaign isn’t available");
  return campaign;
}

export async function updateCampaignBrief(
  userId: string,
  id: string,
  input: { name?: string; brief: unknown; senderIntro?: string | null }
): Promise<void> {
  await requireCampaign(userId, id);
  const brief = parseBrief(input.brief);
  const db = await getDb();
  await db
    .update(outreachCampaigns)
    .set({
      brief,
      audienceQuery: brief.purpose,
      ...(input.name?.trim() ? { name: input.name.trim().slice(0, 120) } : {}),
      ...(input.senderIntro !== undefined ? { senderIntro: input.senderIntro?.trim().slice(0, 1000) || null } : {}),
      updatedAt: new Date(),
    })
    .where(scoped(userId, id));
}

/** Drafts criteria from the brief. Returns them for the editor; nothing is stored until confirmed. */
export async function suggestCriteria(userId: string, id: string, complete: JsonCompleter) {
  const campaign = await requireCampaign(userId, id);
  return criteriaFromBrief(userId, campaign.brief, complete);
}

/**
 * Criteria are only ever stored CONFIRMED: each save is a new `criteria_version`, which is what
 * lets every ranking say which version it reflects (spec §5.1). Confirming after people exist
 * queues one rerank for that version.
 */
export async function saveCriteria(userId: string, id: string, raw: unknown) {
  const campaign = await requireCampaign(userId, id);
  const criteria = normalizeCriteria(raw);
  if (!hasAnyCriteria(criteria)) throw new UserFacingError("Add at least one criterion first");
  const db = await getDb();
  const now = new Date();
  const [updated] = await db
    .update(outreachCampaigns)
    .set({
      criteria,
      criteriaVersion: sql`${outreachCampaigns.criteriaVersion} + 1`,
      criteriaConfirmedAt: now,
      setupStep: laterStep(campaign.setupStep, "people"),
      updatedAt: now,
    })
    .where(scoped(userId, id))
    .returning();

  const [people] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(outreachProspects)
    .where(and(eq(outreachProspects.userId, userId), eq(outreachProspects.campaignId, id)));
  let rerankQueued = false;
  if (Number(people?.n ?? 0) > 0) {
    await enqueueJob({
      userId,
      kind: "ranking.rerank",
      campaignId: id,
      payload: { campaignId: id, criteriaVersion: updated.criteriaVersion },
      idempotencyKey: `rerank:${id}:${updated.criteriaVersion}`,
    });
    rerankQueued = true;
  }
  return { criteriaVersion: updated.criteriaVersion, rerankQueued };
}

export async function listCampaignsForUser(userId: string): Promise<CampaignListItem[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: outreachCampaigns.id,
      name: outreachCampaigns.name,
      generation: outreachCampaigns.generation,
      status: outreachCampaigns.status,
      channel: sql<string | null>`coalesce(${outreachCampaigns.channel}, ${outreachCampaigns.defaultChannel})`,
      setupStep: outreachCampaigns.setupStep,
      updatedAt: outreachCampaigns.updatedAt,
      // Literal `outreach_campaigns.id`, not `${outreachCampaigns.id}`: drizzle drops the table
      // prefix from a column interpolated into a projection, and the correlated subquery would
      // then compare p.campaign_id with p.id and silently count 0.
      prospectCount: sql<number>`(select count(*)::int from outreach_prospects p where p.campaign_id = outreach_campaigns.id)`,
      selectedCount: sql<number>`(select count(*)::int from outreach_prospects p where p.campaign_id = outreach_campaigns.id and p.status = 'selected')`,
    })
    .from(outreachCampaigns)
    .where(eq(outreachCampaigns.userId, userId))
    .orderBy(desc(outreachCampaigns.updatedAt));
  return rows.map((r) => ({ ...r, prospectCount: Number(r.prospectCount), selectedCount: Number(r.selectedCount) }));
}

export async function getDefaultSenderIntro(userId: string): Promise<string> {
  const settings = await ensureUserSettings(userId);
  return settings.outreachSenderIntro ?? "";
}
