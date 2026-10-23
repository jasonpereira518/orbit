/**
 * Outreach writes that do not send anything, user-scoped so chat's writes
 * (@/lib/tools/chat-writes-features) can call them: a campaign's wording, a draft's text, and
 * the outcome of a message the user sent. The server actions in src/actions/outreach.ts wrap
 * the last two; revalidation stays with them.
 *
 * Nothing here sends, schedules, activates a campaign or searches for prospects. Those stay
 * behind the outreach page's own buttons — see the top of `src/lib/mcp/server.ts` for why
 * only a person sends.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { outreachCampaigns, outreachMessages, outreachProspects } from "@/db/schema";
import { logInteractionForUser } from "@/lib/contact-writes";
import { requireEntitlement } from "@/lib/entitlements";
import { UserFacingError } from "@/lib/errors";
import type { OutreachChannel, OutreachMessageOutcome } from "@/lib/outreach-types";
import { requireReleasedSurface } from "@/lib/surface-visibility";

const CAMPAIGN_TEXT_MAX = 4_000;

/** Outreach is a paid, page-gated feature: the same check `requireOutreachUser` makes. */
export async function assertOutreachForUser(userId: string, route = "chat.outreach") {
  await requireEntitlement(userId, "outreach", { route });
  await requireReleasedSurface(userId, "page.outreach");
}

/** The wording fields of a campaign chat may change. Never its audience, status or sequence. */
export type CampaignWording = {
  name?: string;
  messageIntent?: string | null;
  replyCta?: string | null;
  tone?: string;
};

/** Change a campaign's wording; returns those fields before and the row after, or null when it is not the user's. */
export async function updateCampaignWordingForUser(userId: string, campaignId: string, input: CampaignWording) {
  const db = await getDb();
  const where = and(eq(outreachCampaigns.id, campaignId), eq(outreachCampaigns.userId, userId));
  const before = await db.query.outreachCampaigns.findFirst({ where });
  if (!before) return null;
  const patch: Partial<typeof outreachCampaigns.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) {
    const name = input.name.trim().slice(0, CAMPAIGN_TEXT_MAX);
    if (!name) throw new UserFacingError("A campaign needs a name");
    patch.name = name;
  }
  if (input.messageIntent !== undefined) patch.messageIntent = input.messageIntent?.slice(0, CAMPAIGN_TEXT_MAX) ?? null;
  if (input.replyCta !== undefined) patch.replyCta = input.replyCta?.slice(0, CAMPAIGN_TEXT_MAX) ?? null;
  if (input.tone !== undefined) patch.tone = input.tone.slice(0, 64);
  const [after] = await db.update(outreachCampaigns).set(patch).where(where).returning();
  return {
    before: { name: before.name, messageIntent: before.messageIntent, replyCta: before.replyCta, tone: before.tone },
    after,
  };
}

/** One of the user's outreach messages with its prospect and campaign, or null. */
async function ownedMessage(userId: string, messageId: string) {
  const db = await getDb();
  const message = await db.query.outreachMessages.findFirst({
    where: eq(outreachMessages.id, messageId),
    with: { prospect: { with: { campaign: true } } },
  });
  return message && message.prospect.campaign.userId === userId ? message : null;
}

/** Messages whose text is still the user's to change — nothing that has gone out. */
const UNSENT = new Set(["draft", "generated", "scheduled", "copied", "opened"]);

/**
 * Change a message's subject and body. `unsentOnly` refuses one that has gone out, which is
 * how chat calls it; the outreach page's own editor does not pass it. Returns the text before
 * and the row after, or null when the message is not the user's.
 */
export async function updateOutreachDraftForUser(
  userId: string,
  input: { messageId: string; subject?: string | null; body?: string },
  options: { unsentOnly?: boolean } = {}
) {
  const message = await ownedMessage(userId, input.messageId);
  if (!message) return null;
  if (options.unsentOnly && !UNSENT.has(message.status)) {
    throw new UserFacingError("That message has already gone out — its text can’t change now");
  }
  const db = await getDb();
  const [after] = await db
    .update(outreachMessages)
    .set({ subject: input.subject ?? message.subject, body: input.body ?? message.body, updatedAt: new Date() })
    .where(eq(outreachMessages.id, input.messageId))
    .returning();
  return { before: { subject: message.subject, body: message.body }, after, campaignId: message.prospect.campaignId };
}

/**
 * Record how a sent message landed: the message's outcome, the prospect's status, the
 * prospect's still-scheduled follow-ups skipped (unless it bounced), and an interaction on the
 * linked contact. Returns the updated message and its campaign, or null when it is not the user's.
 */
export async function logMessageOutcomeForUser(
  userId: string,
  input: { messageId: string; outcome: OutreachMessageOutcome; notes?: string | null }
) {
  const message = await ownedMessage(userId, input.messageId);
  if (!message) return null;
  const db = await getDb();
  const now = new Date();
  const [updated] = await db
    .update(outreachMessages)
    .set({ outcome: input.outcome, outcomeNotes: input.notes?.trim() || null, repliedAt: now, lastActionAt: now, updatedAt: now })
    .where(eq(outreachMessages.id, input.messageId))
    .returning();

  let prospectStatus: string = message.prospect.status;
  if (input.outcome === "positive_reply") prospectStatus = "interested";
  else if (input.outcome === "negative_reply" || input.outcome === "unsubscribed") prospectStatus = "not_interested";
  else if (input.outcome === "neutral_reply") prospectStatus = "replied";
  await db.update(outreachProspects).set({ status: prospectStatus, updatedAt: now }).where(eq(outreachProspects.id, message.prospectId));

  // Cancel pending follow-ups once there is a reply or a bounce/unsubscribe.
  if (input.outcome !== "bounced") {
    await db
      .update(outreachMessages)
      .set({ status: "skipped", updatedAt: now })
      .where(and(eq(outreachMessages.prospectId, message.prospectId), eq(outreachMessages.status, "scheduled")));
  }

  if (message.prospect.contactId) {
    const channel = message.channel as OutreachChannel;
    await logInteractionForUser(
      userId,
      {
        contactId: message.prospect.contactId,
        interactionType: "outreach",
        source: `outreach:${channel}`,
        rawNotes: input.notes?.trim() || `Outcome: ${input.outcome}`,
        aiSummary: `Outreach ${input.outcome} via ${channel} (campaign ${message.prospect.campaignId})`,
      },
      { skipRevalidate: true }
    );
  }
  return { message: updated, campaignId: message.prospect.campaignId, contactId: message.prospect.contactId };
}
