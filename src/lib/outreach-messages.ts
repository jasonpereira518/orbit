import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, rowsOf, runAtomicBatch } from "@/db";
import { interactions, outreachCampaigns, outreachMessages, outreachProspects } from "@/db/schema";
import type { ContactWriteOptions } from "@/lib/contact-writes";
import "@/lib/email/origin-registrations";
import { ENQUEUE_COPY, chargeEmailBurst, dispatchEmailSend, enqueueEmail, type EnqueueRefusal } from "@/lib/email/outbox";
import { getSendCapability } from "@/lib/email/sender";
import { UserFacingError } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import {
  generateOutreachDraftsBatch,
  type DraftInput,
  type GeneratedDraft,
} from "@/lib/outreach-drafts";
import { ensureProspectContactForUser } from "@/lib/outreach-people";
import { DEMO_PROSPECT_SEND_MESSAGE, isDemoProspect, isPlaceholderAddress } from "@/lib/outreach-quality";
import {
  BULK_SEND_LIMIT,
  MAX_DRAFTS_PER_RUN,
  type OutreachChannel,
  type ProspectEnrichment,
} from "@/lib/outreach-types";
import { listActiveGoalTextsForUser } from "@/lib/user-goals";
import { loadResearchedPeople } from "@/lib/web-research";
import { loadWritingInstructions } from "@/lib/writing-instructions-store";

/**
 * The messages on an outreach campaign.
 *
 * `outreach_messages` has no `user_id` either: every read and write here proves ownership
 * through message → prospect → campaign → `outreach_campaigns.user_id`.
 */

/** The only statuses a message can still be rewritten in. `generated` is the legacy `draft`. */
const REWRITABLE = ["draft", "generated"];

const MAX_BODY = 5000;
const MAX_SUBJECT = 200;

const CAMPAIGN_GONE = "That campaign isn’t yours or no longer exists";
const MESSAGE_GONE = "Message not found";
const ALREADY_SENT = "This message was already sent, so it can’t be edited";

/* ------------------------------------------------------------------ prompt context ----- */

/** What a prospect's `enrichment` says about them, as one line for the draft prompt. */
export function enrichmentSummary(enrichment: unknown): string | null {
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
export const priorNoteSql = sql<string | null>`left(coalesce(nullif(${interactions.aiSummary}, ''), ${interactions.rawNotes}), 500)`;

export function joinPriorNotes(notes: (string | null)[]) {
  return notes.filter(Boolean).join(" | ").slice(0, 500);
}

/**
 * Prior notes for draft generation over a whole prospect list — one `interactions` query
 * instead of one per prospect. A contact with no interaction rows simply has no entry, so
 * callers fall back with `?? null`.
 *
 * The three newest per contact are chosen in SQL (`row_number()` over each contact, newest
 * first), so only those rows, and only the one column the string is built from, come back.
 * Scoped to the caller's account.
 */
export async function priorNotesForContacts(userId: string, contactIds: string[]) {
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

/* ------------------------------------------------------------------ ownership ----- */

async function requireOwnCampaign(userId: string, campaignId: string) {
  if (isUuid(campaignId)) {
    const db = await getDb();
    const campaign = await db.query.outreachCampaigns.findFirst({
      where: and(eq(outreachCampaigns.id, campaignId), eq(outreachCampaigns.userId, userId)),
    });
    if (campaign) return campaign;
  }
  throw new UserFacingError(CAMPAIGN_GONE);
}

/** A message with its person and campaign, only when the campaign is the user's. */
export async function requireMessageForUser(userId: string, messageId: string) {
  if (isUuid(messageId)) {
    const db = await getDb();
    const [row] = await db
      .select({ message: outreachMessages, prospect: outreachProspects, campaign: outreachCampaigns })
      .from(outreachMessages)
      .innerJoin(outreachProspects, eq(outreachProspects.id, outreachMessages.prospectId))
      .innerJoin(outreachCampaigns, eq(outreachCampaigns.id, outreachProspects.campaignId))
      .where(and(eq(outreachMessages.id, messageId), eq(outreachCampaigns.userId, userId)))
      .limit(1);
    if (row) return row;
  }
  throw new UserFacingError(MESSAGE_GONE);
}

/* ------------------------------------------------------------------ drafts ----- */

/** Writes drafts for a list of inputs, in order. `generateOutreachDraftsBatch` by default. */
export type Drafter = (userId: string, inputs: DraftInput[]) => Promise<GeneratedDraft[]>;

/**
 * Write (or rewrite) the first message for up to ten people on a campaign, in the campaign's
 * channel, from what is known about each: why a search matched them, what their brief cites,
 * and what the user has already logged with them.
 *
 * A new person gets a `draft` row. A person whose first message is still a `draft` (or the
 * legacy `generated`) has it rewritten in place. Anyone whose first message has gone any
 * further — copied, queued, sent, failed — is skipped and that message is never touched,
 * and the write itself is conditional on the status, so a send that lands while the model is
 * still writing is not overwritten either.
 *
 * `skipped` counts everyone selected who did not get a draft: a message past `draft`, a send
 * that beat the write, or a model that returned nothing. Ids that aren't selected people on
 * this campaign are ignored, not counted.
 */
export async function draftCampaignMessagesForUser(
  userId: string,
  campaignId: string,
  prospectIds: string[],
  opts: { drafter?: Drafter } = {}
): Promise<{ drafted: number; skipped: number }> {
  if (prospectIds.length > MAX_DRAFTS_PER_RUN) {
    throw new UserFacingError(`Write up to ${MAX_DRAFTS_PER_RUN} drafts at a time`);
  }
  const campaign = await requireOwnCampaign(userId, campaignId);
  const ids = [...new Set(prospectIds.filter(isUuid))];
  if (!ids.length) return { drafted: 0, skipped: 0 };

  const db = await getDb();
  const found = await db
    .select({ prospect: outreachProspects })
    .from(outreachProspects)
    .innerJoin(outreachCampaigns, eq(outreachCampaigns.id, outreachProspects.campaignId))
    .where(
      and(
        inArray(outreachProspects.id, ids),
        eq(outreachProspects.campaignId, campaign.id),
        eq(outreachCampaigns.userId, userId),
        eq(outreachProspects.status, "selected")
      )
    );
  const people = found.map((r) => r.prospect).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  if (!people.length) return { drafted: 0, skipped: 0 };

  // Every first message the person has, in any channel: a sent email still means "already
  // contacted" if the campaign has since moved to LinkedIn.
  const firsts = await db
    .select({ id: outreachMessages.id, prospectId: outreachMessages.prospectId, status: outreachMessages.status })
    .from(outreachMessages)
    .where(and(inArray(outreachMessages.prospectId, people.map((p) => p.id)), eq(outreachMessages.stepIndex, 0)))
    .orderBy(outreachMessages.createdAt);
  const targets = people.flatMap((prospect) => {
    const mine = firsts.filter((m) => m.prospectId === prospect.id);
    if (mine.some((m) => !REWRITABLE.includes(m.status))) return [];
    return [{ prospect, rewriteId: mine[0]?.id ?? null }];
  });
  if (!targets.length) return { drafted: 0, skipped: people.length };

  const channel: OutreachChannel = campaign.defaultChannel === "linkedin" ? "linkedin" : "email";
  const enrichments = targets.map((t) => (t.prospect.enrichment ?? {}) as ProspectEnrichment);
  const [goals, writingInstructions, priorNotes, briefs] = await Promise.all([
    listActiveGoalTextsForUser(userId),
    loadWritingInstructions(userId),
    priorNotesForContacts(userId, targets.flatMap((t) => (t.prospect.contactId ? [t.prospect.contactId] : []))),
    loadResearchedPeople(userId, enrichments.flatMap((e) => (typeof e.researchKey === "string" ? [e.researchKey] : []))),
  ]);

  const inputs: DraftInput[] = targets.map(({ prospect }, i) => {
    const enrichment = enrichments[i]!;
    const brief = typeof enrichment.researchKey === "string" ? briefs.get(enrichment.researchKey) : undefined;
    return {
      channel,
      tone: campaign.tone || "professional",
      messageIntent: campaign.messageIntent || campaign.audienceQuery || "Introduce myself",
      audienceQuery: campaign.audienceQuery,
      replyCta: campaign.replyCta,
      userGoals: goals,
      prospect: {
        fullName: prospect.fullName,
        title: prospect.title,
        company: prospect.company,
        location: prospect.location,
        enrichmentSummary: enrichmentSummary(prospect.enrichment),
        priorNotes: prospect.contactId ? (priorNotes.get(prospect.contactId) ?? null) : null,
        whyMatches: typeof enrichment.whyMatches === "string" ? enrichment.whyMatches : null,
        talkingPoints: brief?.talkingPoints.map((p) => p.text),
      },
      writingInstructions,
    };
  });

  const drafts = await (opts.drafter ?? generateOutreachDraftsBatch)(userId, inputs);

  const inserts: Array<{ prospectId: string; subject: string | null; body: string }> = [];
  const rewrites: Array<{ id: string; subject: string | null; body: string }> = [];
  targets.forEach(({ prospect, rewriteId }, i) => {
    const body = drafts[i]?.body?.trim();
    if (!body) return;
    // A LinkedIn note has no subject line, whatever the model sent.
    const subject = channel === "linkedin" ? null : drafts[i]!.subject?.trim() || null;
    if (rewriteId) rewrites.push({ id: rewriteId, subject, body });
    else inserts.push({ prospectId: prospect.id, subject, body });
  });

  // The model call sits between the read above and this write, so a second run for the same
  // person (another tab, a retry) can have read "no first message" too. There is no unique
  // index on (prospect, step) and no schema change is allowed, so the inserts are serialised
  // per person instead: lock the prospect rows first (in id order, so two overlapping runs
  // can't deadlock), then insert only where no first message exists. Under READ COMMITTED
  // each later statement takes a fresh snapshot, so the run that waited on the lock sees
  // whatever the winner committed and inserts nothing.
  const updatedAt = new Date();
  const lockCount = inserts.length ? 1 : 0;
  const results = await runAtomicBatch(db, (tx) => [
    ...(inserts.length
      ? [
          tx
            .select({ id: outreachProspects.id })
            .from(outreachProspects)
            .where(inArray(outreachProspects.id, inserts.map((r) => r.prospectId)))
            .orderBy(outreachProspects.id)
            .for("update"),
        ]
      : []),
    ...rewrites.map((r) =>
      tx
        .update(outreachMessages)
        .set({ channel, subject: r.subject, body: r.body, updatedAt })
        .where(and(eq(outreachMessages.id, r.id), inArray(outreachMessages.status, REWRITABLE)))
        .returning({ id: outreachMessages.id })
    ),
    ...inserts.map((r) =>
      tx.execute(sql`
        INSERT INTO outreach_messages (prospect_id, channel, subject, body, status, step_index)
        SELECT ${r.prospectId}::uuid, ${channel}::text, ${r.subject}::text, ${r.body}::text, 'draft', 0
         WHERE NOT EXISTS (
           SELECT 1 FROM outreach_messages WHERE prospect_id = ${r.prospectId}::uuid AND step_index = 0
         )
        RETURNING id
      `)
    ),
  ]);
  // Counted from RETURNING: a rewrite that lost to a send, or an insert that lost to another
  // run, wrote nothing and is skipped.
  const drafted = results.slice(lockCount).filter((r) => rowsOf(r).length > 0).length;
  return { drafted, skipped: people.length - drafted };
}

/**
 * Save the user's own edit to a draft. Only a `draft` (or legacy `generated`) message can be
 * edited; one that has gone out is theirs to send, not ours to rewrite. Returns its campaign.
 */
export async function editDraftForUser(
  userId: string,
  messageId: string,
  input: { subject: string | null; body: string }
): Promise<string> {
  const body = typeof input.body === "string" ? input.body.trim() : "";
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  if (!body) throw new UserFacingError("Write a message before saving");
  if (body.length > MAX_BODY) throw new UserFacingError("Keep the message under 5,000 characters");
  if (subject.length > MAX_SUBJECT) throw new UserFacingError("Keep the subject under 200 characters");

  const { message, campaign } = await requireMessageForUser(userId, messageId);
  if (!REWRITABLE.includes(message.status)) throw new UserFacingError(ALREADY_SENT);

  const db = await getDb();
  // Conditional on the status again: it may have changed since the read above.
  const updated = await db
    .update(outreachMessages)
    .set({ subject: subject || null, body, updatedAt: new Date() })
    .where(and(eq(outreachMessages.id, message.id), inArray(outreachMessages.status, REWRITABLE)))
    .returning();
  if (!updated.length) throw new UserFacingError(ALREADY_SENT);
  return campaign.id;
}

/* ------------------------------------------------------------------ send ----- */

/** Spacing between sends in a batch, as recruiter sends do, so a batch trickles out. */
const SEND_SPACING_MS = 1200;
/** Refusals that no later message in the batch could get past either. */
const STOPS_BATCH: EnqueueRefusal[] = ["cap_reached", "not_connected", "no_send_scope", "needs_reauth"];

export type SendCampaignResult = {
  sent: number;
  /** Handed to the outbox but not settled yet (a slow provider): the outbox hook settles them. */
  pending: number;
  failed: { messageId: string; name: string; error: string }[];
};

/**
 * Email up to 25 of a campaign's messages from the user's own mailbox, through the outbox.
 *
 * One UPDATE claims the messages (`draft`, legacy `generated`, or a definite `failed`) by
 * moving them to `queued`; only what it returns goes on, so two sends of one message — a
 * double click, two tabs — email once. The same statement also refuses a second message at
 * the same step for one person, whether it's already out or in the same batch. Anything
 * claimed that this call doesn't hand to the outbox goes back to `draft` before it returns,
 * error or not. Ids that aren't this campaign's emails are ignored.
 *
 * A refused send (no mailbox, today's cap) throws before anything is claimed, so no message
 * moves and no contact is created. The contact is made only for a message about to go out.
 */
export async function sendCampaignMessagesForUser(
  userId: string,
  campaignId: string,
  messageIds: string[],
  opts: { fromName?: string | null; spacingMs?: number; contactWrite?: ContactWriteOptions } = {}
): Promise<SendCampaignResult> {
  const list = Array.isArray(messageIds) ? messageIds : [];
  if (list.length > BULK_SEND_LIMIT) throw new UserFacingError(`Send up to ${BULK_SEND_LIMIT} at a time`);
  const campaign = await requireOwnCampaign(userId, campaignId);
  if (campaign.defaultChannel !== "email") throw new UserFacingError("This campaign isn’t set up for email");
  const ids = [...new Set(list.filter(isUuid))];
  const result: SendCampaignResult = { sent: 0, pending: 0, failed: [] };
  if (!ids.length) return result;

  const capability = await getSendCapability(userId);
  if (!capability.ok) throw new UserFacingError(ENQUEUE_COPY[capability.reason]);
  // One batch is one burst; the daily cap still counts every message.
  const limited = await chargeEmailBurst(userId);
  if (limited && !limited.ok) throw new UserFacingError(limited.message);

  // The claim, and with it the double-send guard: one statement. The outer status check is
  // re-evaluated against a row a concurrent claim just changed, so only one claim gets it.
  // DISTINCT ON keeps one message per person and step out of this batch, and NOT EXISTS
  // refuses one whose person already has another at that step that went out or may have.
  // ponytail: two concurrent calls each holding a DIFFERENT message for one person and step
  // can both pass NOT EXISTS (neither sees the other's uncommitted claim); drafting already
  // keeps one step-0 message per person, so this is the belt, not the braces.
  const db = await getDb();
  const claimedIds = rowsOf<{ id: string }>(
    await db.execute(sql`
      UPDATE outreach_messages m
         SET status = 'queued', error_message = NULL, updated_at = now()
       WHERE m.status IN ('draft', 'generated', 'failed')
         AND m.id IN (
           SELECT DISTINCT ON (c.prospect_id, c.step_index) c.id
             FROM outreach_messages c
             JOIN outreach_prospects p ON p.id = c.prospect_id
             JOIN outreach_campaigns k ON k.id = p.campaign_id
            WHERE c.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
              AND c.status IN ('draft', 'generated', 'failed')
              AND c.channel = 'email'
              AND p.campaign_id = ${campaign.id}::uuid
              AND p.status <> 'excluded'
              AND k.user_id = ${userId}
            ORDER BY c.prospect_id, c.step_index, c.created_at, c.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM outreach_messages o
            WHERE o.prospect_id = m.prospect_id
              AND o.step_index = m.step_index
              AND o.id <> m.id
              AND o.status IN ('queued', 'sent', 'unsure', 'copied', 'opened')
         )
      RETURNING m.id
    `)
  ).map((r) => r.id);
  if (!claimedIds.length) return result;

  // Oldest first; a tie (one draft run) keeps the order the ids were given in.
  const rows = (
    await db
      .select({ message: outreachMessages, prospect: outreachProspects })
      .from(outreachMessages)
      .innerJoin(outreachProspects, eq(outreachProspects.id, outreachMessages.prospectId))
      .innerJoin(outreachCampaigns, eq(outreachCampaigns.id, outreachProspects.campaignId))
      .where(and(inArray(outreachMessages.id, claimedIds), eq(outreachCampaigns.userId, userId)))
  ).sort(
    (a, b) =>
      a.message.createdAt.getTime() - b.message.createdAt.getTime() ||
      ids.indexOf(a.message.id) - ids.indexOf(b.message.id)
  );

  // Claimed but not yet the outbox's: whatever is left here goes back to `draft` at the end.
  const unsent = new Set(claimedIds);
  const spacingMs = opts.spacingMs ?? SEND_SPACING_MS;
  let handedOff = 0;
  try {
    for (const [index, { message, prospect }] of rows.entries()) {
      const fail = (error: string) => result.failed.push({ messageId: message.id, name: prospect.fullName, error });
      if (index >= capability.remainingToday) {
        fail(ENQUEUE_COPY.cap_reached);
        break;
      }
      if (isDemoProspect(prospect.enrichment)) {
        fail(DEMO_PROSPECT_SEND_MESSAGE);
        continue;
      }
      const email = prospect.email?.trim().toLowerCase();
      if (!email || isPlaceholderAddress(email)) {
        fail(`Add an email address for ${prospect.fullName} first`);
        continue;
      }
      if (handedOff && spacingMs > 0) await new Promise((resolve) => setTimeout(resolve, spacingMs));

      const contactId = await ensureProspectContactForUser(userId, prospect.id, opts.contactWrite);
      // A follow-up (step 1) goes out as its own message for now; Task 8 threads it under the first.
      const queued = await enqueueEmail(userId, {
        to: [email],
        subject: message.subject ?? "",
        bodyText: message.body,
        fromName: opts.fromName,
        origin: "outreach",
        originRef: message.id,
        idempotencyKey: `outreach:${message.id}`,
        contactIds: [contactId],
        delayMs: 0,
        chargeBurst: false,
      });
      if (!queued.ok) {
        fail(queued.message);
        if (STOPS_BATCH.includes(queued.reason)) break;
        await db
          .update(outreachMessages)
          .set({ status: "failed", errorMessage: queued.message, updatedAt: new Date() })
          .where(and(eq(outreachMessages.id, message.id), eq(outreachMessages.status, "queued")));
        unsent.delete(message.id);
        continue;
      }
      // The outbox owns it now: its hook (origin-hooks/outreach.ts) settles the message.
      unsent.delete(message.id);
      handedOff += 1;
      const outcome = await dispatchEmailSend(queued.id);
      if (outcome === "sent") result.sent += 1;
      else if (outcome === "retry") result.pending += 1;
      else fail(`Couldn’t send to ${prospect.fullName} — try again?`);
    }
  } finally {
    if (unsent.size) {
      await db
        .update(outreachMessages)
        .set({ status: "draft", updatedAt: new Date() })
        .where(and(inArray(outreachMessages.id, [...unsent]), eq(outreachMessages.status, "queued")));
    }
  }
  return result;
}
