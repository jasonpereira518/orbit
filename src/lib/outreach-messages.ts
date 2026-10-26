import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, rowsOf, runAtomicBatch } from "@/db";
import { interactions, outreachCampaigns, outreachMessages, outreachProspects } from "@/db/schema";
import { logInteractionForUser, type ContactWriteOptions } from "@/lib/contact-writes";
import "@/lib/email/origin-registrations";
import { ENQUEUE_COPY, chargeEmailBurst, dispatchEmailSend, enqueueEmail, type EnqueueRefusal } from "@/lib/email/outbox";
import { replySubject, resolveReplyTarget } from "@/lib/email/reply-targets";
import { getSendCapability } from "@/lib/email/sender";
import { UserFacingError } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import {
  generateOutreachDraftsBatch,
  type DraftInput,
  type GeneratedDraft,
} from "@/lib/outreach-drafts";
import { followUpDue } from "@/lib/outreach-followups";
import { ensureProspectContactForUser } from "@/lib/outreach-people";
import { DEMO_PROSPECT_SEND_MESSAGE, isDemoProspect, isPlaceholderAddress } from "@/lib/outreach-quality";
import {
  BULK_SEND_LIMIT,
  LINKEDIN_NOTE_MAX,
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
const NOT_LINKEDIN = "This campaign isn’t set up for LinkedIn";
const FOLLOW_UP_NOT_DUE = "A follow-up isn’t due for this person yet";
const FOLLOW_UP_EXISTS = "A follow-up is already written for this person";
/**
 * A LinkedIn profile link the browser may be sent to. Prospects added through `/outreach` only
 * ever hold an https one, but the older search path stores whatever its provider returned, and
 * this URL is opened by the client — so a `javascript:` or off-site value is treated as no link.
 */
const LINKEDIN_PROFILE_RE = /^https?:\/\/([a-z0-9-]+\.)*linkedin\.com\/in\/[^\s]+$/i;

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
 * What the model is told about each person: the campaign's tone, intent and ask, the user's
 * goals and writing notes, and per person what is known (a search's reason, their brief, what the
 * user has logged with them). The one place that builds it, so a first message and a follow-up
 * are written from the same context.
 */
async function draftInputsFor(
  userId: string,
  campaign: typeof outreachCampaigns.$inferSelect,
  channel: OutreachChannel,
  people: Array<typeof outreachProspects.$inferSelect>
): Promise<DraftInput[]> {
  const enrichments = people.map((p) => (p.enrichment ?? {}) as ProspectEnrichment);
  const [goals, writingInstructions, priorNotes, briefs] = await Promise.all([
    listActiveGoalTextsForUser(userId),
    loadWritingInstructions(userId),
    priorNotesForContacts(userId, people.flatMap((p) => (p.contactId ? [p.contactId] : []))),
    loadResearchedPeople(userId, enrichments.flatMap((e) => (typeof e.researchKey === "string" ? [e.researchKey] : []))),
  ]);

  return people.map((prospect, i) => {
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
}

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
  const inputs = await draftInputsFor(userId, campaign, channel, targets.map((t) => t.prospect));

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

/**
 * Write the one follow-up for a person whose first message went unanswered: a `draft` at
 * `step_index` 1 under the first message, in the first message's channel. Only `followUpDue`
 * (sent a week ago, no outcome, no follow-up yet) allows it. Returns the new message's id.
 *
 * Step 1 stays one message per person, with the same lock-then-conditional-insert as step 0:
 * the model call sits between the check above and the write, so two runs for one person (a double
 * click, two tabs) both pass the check. The prospect row is locked, then the insert is skipped if
 * a step-1 message exists — in any status — and the run that loses is told so.
 */
export async function draftFollowUpForUser(
  userId: string,
  firstMessageId: string,
  opts: { drafter?: Drafter; now?: Date } = {}
): Promise<{ messageId: string }> {
  const { message: first, prospect, campaign } = await requireMessageForUser(userId, firstMessageId);
  const db = await getDb();
  const [existing] = await db
    .select({ id: outreachMessages.id })
    .from(outreachMessages)
    .where(and(eq(outreachMessages.prospectId, prospect.id), eq(outreachMessages.stepIndex, 1)))
    .limit(1);
  if (!followUpDue(first, Boolean(existing), opts.now ?? new Date())) {
    throw new UserFacingError(existing ? FOLLOW_UP_EXISTS : FOLLOW_UP_NOT_DUE);
  }

  const channel = first.channel as OutreachChannel;
  const [input] = await draftInputsFor(userId, campaign, channel, [prospect]);
  const [draft] = await (opts.drafter ?? generateOutreachDraftsBatch)(userId, [
    { ...input!, stepIndex: 1, previousBody: first.body },
  ]);
  const body = draft?.body?.trim();
  if (!body) throw new UserFacingError("Couldn’t write the follow-up — try again");
  // An email follow-up goes out under the first one's subject (see the send below); a LinkedIn
  // note has none.
  const subject = channel === "linkedin" ? null : replySubject(first.subject ?? "");

  const [, insert] = await runAtomicBatch(db, (tx) => [
    tx.select({ id: outreachProspects.id }).from(outreachProspects).where(eq(outreachProspects.id, prospect.id)).orderBy(outreachProspects.id).for("update"),
    tx.execute(sql`
      INSERT INTO outreach_messages (prospect_id, channel, subject, body, status, step_index, parent_message_id)
      SELECT ${prospect.id}::uuid, ${first.channel}::text, ${subject}::text, ${body}::text, 'draft', 1, ${first.id}::uuid
       WHERE NOT EXISTS (
         SELECT 1 FROM outreach_messages WHERE prospect_id = ${prospect.id}::uuid AND step_index = 1
       )
      RETURNING id
    `),
  ]);
  const inserted = rowsOf<{ id: string }>(insert)[0];
  if (!inserted) throw new UserFacingError(FOLLOW_UP_EXISTS);
  return { messageId: inserted.id };
}

/* ------------------------------------------------------------------ send ----- */

/** Spacing between sends in a batch, as recruiter sends do, so a batch trickles out. */
const SEND_SPACING_MS = 1200;
/**
 * Stop handing messages to the outbox after this long. The page runs under a 60s
 * `maxDuration`, and a killed function never runs the `finally` that puts unsent claims back:
 * a message stranded in `queued` can't be claimed, edited or removed again.
 */
const SEND_BUDGET_MS = 40_000;
/** Refusals that no later message in the batch could get past either. */
const STOPS_BATCH: EnqueueRefusal[] = ["cap_reached", "not_connected", "no_send_scope", "needs_reauth"];

/**
 * Put back as drafts the campaign's messages that a killed send left in `queued` with nothing
 * in the outbox: one UPDATE, scoped to the user's own campaign through `outreach_campaigns`.
 * Returns how many it released.
 *
 * A message is stranded when it was claimed, the function died before the `finally` below could
 * put it back, and no `email_sends` row was ever made for it (an outbox row means the hook
 * settles it, however slowly). Five minutes is safe because the page runs under a 60s
 * `maxDuration`, so no live send still holds a claim that old.
 */
export async function releaseStrandedMessagesForUser(userId: string, campaignId: string): Promise<number> {
  if (!isUuid(campaignId)) return 0;
  const db = await getDb();
  return rowsOf(
    await db.execute(sql`
      UPDATE outreach_messages m
         SET status = 'draft', updated_at = now()
        FROM outreach_prospects p
        JOIN outreach_campaigns k ON k.id = p.campaign_id
       WHERE p.id = m.prospect_id
         AND k.id = ${campaignId}::uuid
         AND k.user_id = ${userId}
         AND m.status = 'queued'
         AND m.updated_at < now() - interval '5 minutes'
         AND NOT EXISTS (
           SELECT 1 FROM email_sends s
            WHERE s.user_id = ${userId} AND s.origin = 'outreach' AND s.origin_ref = m.id::text
         )
      RETURNING m.id
    `)
  ).length;
}

export type SendCampaignResult = {
  sent: number;
  /** Handed to the outbox but not settled yet (a slow provider): the outbox hook settles them. */
  pending: number;
  /** Claimed, then put back as drafts because the batch ran out of time: send them again. */
  notSent: number;
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
 * error or not (and a message a killed send stranded in `queued` is released first, see
 * `releaseStrandedMessagesForUser`). After `budgetMs` (40s) it stops handing messages over, well inside the
 * page's 60s limit, and counts the rest as `notSent`. Ids that aren't this campaign's
 * emails are ignored.
 *
 * A refused send (no mailbox, today's cap) throws before anything is claimed, so no message
 * moves and no contact is created. The contact is made only for a message about to go out.
 *
 * A follow-up (`step_index` 1) goes out as a reply to its first message, in the same thread.
 */
export async function sendCampaignMessagesForUser(
  userId: string,
  campaignId: string,
  messageIds: string[],
  opts: { fromName?: string | null; spacingMs?: number; budgetMs?: number; contactWrite?: ContactWriteOptions } = {}
): Promise<SendCampaignResult> {
  const start = Date.now();
  const list = Array.isArray(messageIds) ? messageIds : [];
  if (list.length > BULK_SEND_LIMIT) throw new UserFacingError(`Send up to ${BULK_SEND_LIMIT} at a time`);
  const campaign = await requireOwnCampaign(userId, campaignId);
  if (campaign.defaultChannel !== "email") throw new UserFacingError("This campaign isn’t set up for email");
  await releaseStrandedMessagesForUser(userId, campaign.id);
  const ids = [...new Set(list.filter(isUuid))];
  const result: SendCampaignResult = { sent: 0, pending: 0, notSent: 0, failed: [] };
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

  // Claimed but not yet the outbox's: whatever is left here goes back to `draft` at the end.
  // The try opens right here, so nothing after the claim can strand a claimed message.
  const unsent = new Set(claimedIds);
  const spacingMs = opts.spacingMs ?? SEND_SPACING_MS;
  const budgetMs = opts.budgetMs ?? SEND_BUDGET_MS;
  let handedOff = 0;
  try {
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

    // A follow-up goes out as a reply under its first message, so that one is read up front: its
    // subject and the outbox row it was sent as. Scoped to the user's own campaigns like the rest.
    const parentIds = [...new Set(rows.flatMap((r) => (r.message.stepIndex === 1 && r.message.parentMessageId ? [r.message.parentMessageId] : [])))];
    const parents = new Map(
      (parentIds.length
        ? await db
            .select({ id: outreachMessages.id, subject: outreachMessages.subject, deliveryId: outreachMessages.deliveryId })
            .from(outreachMessages)
            .innerJoin(outreachProspects, eq(outreachProspects.id, outreachMessages.prospectId))
            .innerJoin(outreachCampaigns, eq(outreachCampaigns.id, outreachProspects.campaignId))
            .where(and(inArray(outreachMessages.id, parentIds), eq(outreachCampaigns.userId, userId)))
        : []
      ).map((p) => [p.id, p] as const)
    );

    for (const [index, { message, prospect }] of rows.entries()) {
      const fail = (error: string) => result.failed.push({ messageId: message.id, name: prospect.fullName, error });
      if (index >= capability.remainingToday) {
        fail(ENQUEUE_COPY.cap_reached);
        break;
      }
      if (Date.now() - start >= budgetMs) {
        result.notSent = rows.length - index;
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
      // A follow-up (step 1) replies to its first message: "Re:" its subject, with the reply
      // headers and the provider thread when the first send is on record (`resolveReplyTarget`
      // re-reads it by owner and only trusts a thread from this exact mailbox). Without one it
      // is a fresh message with the same "Re:" subject.
      const parent = message.stepIndex === 1 && message.parentMessageId ? parents.get(message.parentMessageId) : undefined;
      const target = parent?.deliveryId ? await resolveReplyTarget(userId, `orbit:${parent.deliveryId}`) : null;
      const queued = await enqueueEmail(userId, {
        to: [email],
        subject: parent ? replySubject(target?.subject ?? parent.subject ?? "") : (message.subject ?? ""),
        inReplyToRfcId: target?.rfcMessageId,
        inReplyToSendId: target?.inReplyToSendId,
        threadId: target?.thread?.threadId,
        provider: target?.thread?.provider,
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

/* ------------------------------------------------------------------ LinkedIn ----- */

/**
 * The note and the profile link for a LinkedIn message, ready for the user to paste and send
 * by hand — Orbit never sends or automates anything on LinkedIn. A `draft` (or legacy
 * `generated`) message becomes `copied`; one already copied, or past that, comes back as is.
 * The link is the one stored on the prospect, and only a `linkedin.com/in/…` one counts.
 */
export async function copyLinkedInMessageForUser(
  userId: string,
  messageId: string
): Promise<{ body: string; linkedinUrl: string }> {
  const { message, prospect, campaign } = await requireMessageForUser(userId, messageId);
  if (campaign.defaultChannel !== "linkedin") throw new UserFacingError(NOT_LINKEDIN);
  const linkedinUrl = prospect.linkedinUrl?.trim();
  if (!linkedinUrl || !LINKEDIN_PROFILE_RE.test(linkedinUrl)) {
    throw new UserFacingError("Add their LinkedIn profile link first");
  }
  if (message.body.length > LINKEDIN_NOTE_MAX) {
    throw new UserFacingError(`LinkedIn notes are limited to ${LINKEDIN_NOTE_MAX} characters — shorten this one`);
  }
  if (REWRITABLE.includes(message.status)) {
    const db = await getDb();
    await db
      .update(outreachMessages)
      .set({ status: "copied", updatedAt: new Date() })
      .where(and(eq(outreachMessages.id, message.id), inArray(outreachMessages.status, REWRITABLE)));
  }
  return { body: message.body, linkedinUrl };
}

/**
 * The user says they sent a copied note on LinkedIn: `copied` → `sent`, the person becomes a
 * contact (if they weren't one), and the note goes on their timeline as an outgoing message.
 *
 * One conditional UPDATE decides whether this call is the confirmation. `logInteractionForUser`
 * is a plain insert on a unique `external_id`, so a double click or a second tab must not log
 * twice: a message that is already `sent` is only finished off when its interaction is missing
 * (a first confirm that died after the UPDATE), and returns quietly when it is there. Pressing
 * "I sent it" again is therefore how a failed first confirm is recovered.
 */
export async function confirmLinkedInSentForUser(
  userId: string,
  messageId: string,
  opts?: ContactWriteOptions
): Promise<void> {
  const { message, prospect, campaign } = await requireMessageForUser(userId, messageId);
  if (campaign.defaultChannel !== "linkedin") throw new UserFacingError(NOT_LINKEDIN);

  const db = await getDb();
  const externalId = `outreach:${message.id}`;
  const matched = rowsOf<{ id: string }>(
    await db.execute(sql`
      UPDATE outreach_messages
         SET status = 'sent', sent_at = now(), updated_at = now()
       WHERE id = ${message.id}::uuid AND status = 'copied'
      RETURNING id
    `)
  );
  if (!matched.length) {
    // Judged on the status as it is now: a confirm that ran between the read above and the
    // UPDATE has moved it on. `opened` is a delivered status on legacy rows, logged elsewhere.
    const [now] = await db.select({ status: outreachMessages.status }).from(outreachMessages).where(eq(outreachMessages.id, message.id));
    if (now?.status === "opened") return;
    if (now?.status !== "sent") {
      throw new UserFacingError(REWRITABLE.includes(now?.status ?? "") ? "Copy the note first" : "This message can’t be marked as sent");
    }
    const [logged] = await db
      .select({ id: interactions.id })
      .from(interactions)
      .where(and(eq(interactions.userId, userId), eq(interactions.externalId, externalId)))
      .limit(1);
    if (logged) return;
  }

  const contactId = await ensureProspectContactForUser(userId, prospect.id, opts);
  try {
    await logInteractionForUser(
      userId,
      {
        contactId,
        interactionType: "linkedin_message",
        direction: "out",
        source: "outreach_send",
        externalId,
        interactionDate: new Date(),
        rawNotes: message.body,
      },
      opts
    );
  } catch (err) {
    // Two recoveries at once: the other one's insert won the unique `external_id`. Done.
    const e = err as { code?: string; cause?: { code?: string } } | null;
    if (e?.code !== "23505" && e?.cause?.code !== "23505") throw err;
  }
}
