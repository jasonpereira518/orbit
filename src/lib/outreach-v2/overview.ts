import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { outreachCampaigns as campaigns } from "@/db/schema";

/** Aggregate at the database boundary: no message bodies or provider credentials leave it. */
export async function outreachOverview(userId: string) {
  const db = await getDb();
  const campaignId = sql`"outreach_campaigns"."id"`;
  const channel = sql`"outreach_campaigns"."default_channel"`;
  const version = sql`"outreach_campaigns"."version"`;
  return db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      description: campaigns.audienceQuery,
      channel: campaigns.defaultChannel,
      version: campaigns.version,
      status: campaigns.status,
      paused: campaigns.paused,
      updatedAt: sql<Date>`greatest(${campaigns.updatedAt},
      (select max(j.updated_at) from outreach_jobs j where j.campaign_id = ${campaignId} and j.user_id = ${userId}),
      (select max(c.last_human_reply_at) from outreach_conversations c where c.campaign_id = ${campaignId} and c.user_id = ${userId}))`,
      people: sql<number>`(select count(*)::int from outreach_prospects p where p.campaign_id = ${campaignId} and p.status <> 'skipped')`,
      drafts: sql<number>`(select count(*)::int from outreach_messages m join outreach_prospects p on p.id = m.prospect_id
      where p.campaign_id = ${campaignId} and p.status <> 'skipped' and m.channel = ${channel}
      and ${version} = 2 and m.execution_status in ('idle','failed','cancelled')
      and m.approved_revision is distinct from m.revision)`,
      ready: sql<number>`(select count(*)::int from outreach_messages m join outreach_prospects p on p.id = m.prospect_id
      where p.campaign_id = ${campaignId} and p.status <> 'skipped' and m.channel = ${channel}
      and ${version} = 2 and m.execution_status in ('idle','failed','cancelled') and m.approved_revision = m.revision)`,
      sent: sql<number>`(select count(*)::int from outreach_messages m join outreach_prospects p on p.id = m.prospect_id
      where p.campaign_id = ${campaignId} and (case when ${version} = 2 then m.execution_status = 'confirmed' else m.sent_at is not null end))`,
      unread: sql<number>`(select count(*)::int from outreach_conversations c where c.campaign_id = ${campaignId} and c.user_id = ${userId} and c.unread)`,
      positive: sql<number>`(select count(*)::int from outreach_conversations c where c.campaign_id = ${campaignId} and c.user_id = ${userId} and c.outcome = 'positive_reply')`,
      issues: sql<number>`(select count(*)::int from outreach_jobs j where j.campaign_id = ${campaignId} and j.user_id = ${userId} and j.status in ('failed','needs_verification') and j.kind in ('send','browser_send'))`,
    })
    .from(campaigns)
    .where(eq(campaigns.userId, userId));
}
export type CampaignSummary = Awaited<
  ReturnType<typeof outreachOverview>
>[number];
