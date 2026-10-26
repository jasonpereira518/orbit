import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { emailSends, outreachCampaigns, outreachMessages, outreachProspects } from "@/db/schema";
import { logInteractionForUser, type ContactWriteOptions } from "@/lib/contact-writes";
import { repliedSince } from "@/lib/email/inbox-threads";
import { UserFacingError } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { requireMessageForUser } from "@/lib/outreach-messages";
import {
  OUTCOME_LABELS,
  REPLY_CHECKS_PER_PASS,
  REPLY_CHECK_WINDOW_DAYS,
  type OutreachMessageOutcome,
} from "@/lib/outreach-types";
import { consumeBucket, isRateLimitedError, RATE_LIMITS } from "@/lib/rate-limit";

/**
 * Who answered a campaign's email, and what the user says came of it.
 *
 * Both write only `outreach_messages.outcome`: `outreach_prospects.status` stays `selected`,
 * because the cap, drafting and the People list key on it. Ownership always runs through
 * campaign → `outreach_campaigns.user_id`.
 */

const DAY_MS = 86_400_000;
/** Mailbox searches in flight at once: 25 in a burst is a lot for one user's Gmail quota. */
const LOOKUPS_AT_ONCE = 5;

/** The outcomes that mean the person wrote back (a bounce or an unsubscribe is not a reply). */
const REPLY_OUTCOMES: OutreachMessageOutcome[] = ["replied", "positive_reply", "negative_reply", "neutral_reply"];

/** Postgres unique violation, as the driver reports it (directly, or wrapped by drizzle). */
function isUniqueViolation(err: unknown) {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/* ------------------------------------------------------------------ manual outcome ----- */

/**
 * Record what came of a message, by hand: `outcome`, optional notes, and when they replied.
 * Returns the message's campaign (to revalidate).
 *
 * An outcome that is already set can be changed (a detected `replied` refined to a positive
 * one). Notes are left alone when `notes` is omitted and cleared by `null` or blank. `repliedAt`
 * is set for a reply outcome and never moved once set, so refining keeps the detected time; a
 * bounce or unsubscribe clears it. Anything but a bounce also cancels the person's scheduled
 * follow-ups. The outcome goes on the contact's timeline once per message (a repeat is a
 * unique-key no-op), for a person who has a contact.
 *
 * Dropped from the old `logMessageOutcome`: it also rewrote the prospect's `status` to
 * `interested` / `not_interested` / `replied`, which is what took them out of `selected`.
 */
export async function setMessageOutcomeForUser(
  userId: string,
  messageId: string,
  outcome: OutreachMessageOutcome,
  notes?: string | null,
  opts?: ContactWriteOptions
): Promise<string> {
  if (!Object.hasOwn(OUTCOME_LABELS, outcome)) throw new UserFacingError("That isn’t an outcome Orbit tracks");
  const { message, prospect, campaign } = await requireMessageForUser(userId, messageId);
  const now = new Date();
  const kept = notes === undefined ? message.outcomeNotes : notes?.trim() || null;

  const db = await getDb();
  await db
    .update(outreachMessages)
    .set({
      outcome,
      outcomeNotes: kept,
      repliedAt: REPLY_OUTCOMES.includes(outcome) ? (message.repliedAt ?? now) : null,
      lastActionAt: now,
      updatedAt: now,
    })
    .where(eq(outreachMessages.id, message.id));

  // A reply, a refusal or an unsubscribe ends the sequence; a bounce says nothing about it.
  if (outcome !== "bounced") {
    await db
      .update(outreachMessages)
      .set({ status: "skipped", updatedAt: now })
      .where(and(eq(outreachMessages.prospectId, prospect.id), eq(outreachMessages.status, "scheduled")));
  }

  if (prospect.contactId) {
    try {
      await logInteractionForUser(
        userId,
        {
          contactId: prospect.contactId,
          interactionType: "outreach",
          source: `outreach:${message.channel}`,
          externalId: `outreach-outcome:${message.id}`,
          rawNotes: kept || `Outcome: ${outcome}`,
          aiSummary: `Outreach ${outcome} via ${message.channel} (campaign ${campaign.id})`,
        },
        opts
      );
    } catch (err) {
      // A change of outcome: this message is already on the timeline.
      if (!isUniqueViolation(err)) throw err;
    }
  }
  return campaign.id;
}

/* ------------------------------------------------------------------ detection ----- */

/** `repliedSince` by default; a smoke passes a fake so no mailbox is needed. */
export type ReplyLookup = typeof repliedSince;

/**
 * Look in the user's own mailbox for a message FROM each recipient since the send, and mark
 * those who wrote back `replied`. Metadata only — sender and date, never a subject or body.
 *
 * Checks the campaign's email messages that are `sent`, have no outcome, and went out within
 * 60 days; oldest send first, 25 per pass (everyone else waits for the next one). A message
 * is looked up through the user's own `email_sends` row (joined as text: `delivery_id` is
 * `text` and a v1 row may hold something that isn't a uuid), so a demo send, a v1 send with
 * no outbox row, and a prospect with no email are skipped and don't count as checked.
 *
 * A campaign that isn't the user's checks nothing. Once per ten minutes per user and
 * campaign (`throttled: true` otherwise); `skipThrottle` is for smokes. The mark is one
 * UPDATE guarded `outcome IS NULL`, so an outcome the user sets meanwhile is never overwritten.
 */
export async function checkCampaignRepliesForUser(
  userId: string,
  campaignId: string,
  opts: { now?: Date; lookup?: ReplyLookup; skipThrottle?: boolean } = {}
): Promise<{ checked: number; replied: number; throttled: boolean }> {
  const nothing = { checked: 0, replied: 0, throttled: false };
  if (!isUuid(campaignId)) return nothing;
  const db = await getDb();
  const own = await db.query.outreachCampaigns.findFirst({
    where: and(eq(outreachCampaigns.id, campaignId), eq(outreachCampaigns.userId, userId)),
    columns: { id: true },
  });
  if (!own) return nothing;

  if (!opts.skipThrottle) {
    try {
      await consumeBucket("outreach-reply-check", `${userId}:${campaignId}`, RATE_LIMITS.outreachReplyCheck);
    } catch (err) {
      if (isRateLimitedError(err)) return { ...nothing, throttled: true };
      throw err;
    }
  }

  const now = opts.now ?? new Date();
  const lookup = opts.lookup ?? repliedSince;
  const rows = await db
    .select({
      id: outreachMessages.id,
      sentAt: outreachMessages.sentAt,
      email: outreachProspects.email,
      provider: sql<"gmail" | "outlook">`${emailSends.provider}`,
    })
    .from(outreachMessages)
    .innerJoin(outreachProspects, eq(outreachProspects.id, outreachMessages.prospectId))
    .innerJoin(outreachCampaigns, eq(outreachCampaigns.id, outreachProspects.campaignId))
    .innerJoin(
      emailSends,
      and(sql`${emailSends.id}::text = ${outreachMessages.deliveryId}`, eq(emailSends.userId, outreachCampaigns.userId))
    )
    .where(
      and(
        eq(outreachCampaigns.id, own.id),
        eq(outreachCampaigns.userId, userId),
        eq(outreachMessages.channel, "email"),
        eq(outreachMessages.status, "sent"),
        isNull(outreachMessages.outcome),
        gte(outreachMessages.sentAt, new Date(now.getTime() - REPLY_CHECK_WINDOW_DAYS * DAY_MS)),
        inArray(emailSends.provider, ["gmail", "outlook"]),
        sql`btrim(coalesce(${outreachProspects.email}, '')) <> ''`
      )
    )
    .orderBy(asc(outreachMessages.sentAt), asc(outreachMessages.id))
    .limit(REPLY_CHECKS_PER_PASS);

  let replied = 0;
  for (let i = 0; i < rows.length; i += LOOKUPS_AT_ONCE) {
    const batch = rows.slice(i, i + LOOKUPS_AT_ONCE);
    // sentAt and email are non-null: the WHERE above requires both.
    // ponytail: an auto-reply counts as a reply; telling them apart means reading bodies, which needs a privacy change
    const found = await Promise.all(batch.map((r) => lookup(userId, r.provider, r.email!.trim(), r.sentAt!)));
    for (const [j, at] of found.entries()) {
      if (!at) continue;
      replied += rowsOf(
        await db.execute(sql`
          UPDATE outreach_messages m
             SET outcome = 'replied', replied_at = ${at.toISOString()}::timestamptz, updated_at = now()
            FROM outreach_prospects p
            JOIN outreach_campaigns k ON k.id = p.campaign_id
           WHERE p.id = m.prospect_id
             AND k.user_id = ${userId}
             AND m.id = ${batch[j]!.id}::uuid
             AND m.outcome IS NULL
          RETURNING m.id
        `)
      ).length;
    }
  }
  return { checked: rows.length, replied, throttled: false };
}
