import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, rowsOf, runAtomicBatch } from "@/db";
import { interactions, outreachCampaigns, outreachMessages, outreachProspects } from "@/db/schema";
import { UserFacingError } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import {
  generateOutreachDraftsBatch,
  type DraftInput,
  type GeneratedDraft,
} from "@/lib/outreach-drafts";
import { MAX_DRAFTS_PER_RUN, type OutreachChannel, type ProspectEnrichment } from "@/lib/outreach-types";
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

  const inserts: Array<typeof outreachMessages.$inferInsert> = [];
  const rewrites: Array<{ id: string; subject: string | null; body: string }> = [];
  targets.forEach(({ prospect, rewriteId }, i) => {
    const body = drafts[i]?.body?.trim();
    if (!body) return;
    // A LinkedIn note has no subject line, whatever the model sent.
    const subject = channel === "linkedin" ? null : drafts[i]!.subject?.trim() || null;
    if (rewriteId) rewrites.push({ id: rewriteId, subject, body });
    else inserts.push({ prospectId: prospect.id, channel, subject, body, status: "draft", stepIndex: 0 });
  });

  // ponytail: two runs at once for one person can both insert; there is no unique index on
  // (prospect, step) and no schema change is allowed here. Add one if a double click shows up.
  const updatedAt = new Date();
  const results = await runAtomicBatch(db, (tx) => [
    ...rewrites.map((r) =>
      tx
        .update(outreachMessages)
        .set({ channel, subject: r.subject, body: r.body, updatedAt })
        .where(and(eq(outreachMessages.id, r.id), inArray(outreachMessages.status, REWRITABLE)))
        .returning({ id: outreachMessages.id })
    ),
    ...(inserts.length ? [tx.insert(outreachMessages).values(inserts)] : []),
  ]);
  const rewritten = results.slice(0, rewrites.length).filter((r) => rowsOf(r).length > 0).length;
  const drafted = rewritten + inserts.length;
  return { drafted, skipped: people.length - drafted };
}

/**
 * Save the user's own edit to a draft. Only a `draft` (or legacy `generated`) message can be
 * edited; one that has gone out is theirs to send, not ours to rewrite.
 */
export async function editDraftForUser(
  userId: string,
  messageId: string,
  input: { subject: string | null; body: string }
): Promise<void> {
  const body = typeof input.body === "string" ? input.body.trim() : "";
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  if (!body) throw new UserFacingError("Write a message before saving");
  if (body.length > MAX_BODY) throw new UserFacingError("Keep the message under 5,000 characters");
  if (subject.length > MAX_SUBJECT) throw new UserFacingError("Keep the subject under 200 characters");

  const { message } = await requireMessageForUser(userId, messageId);
  if (!REWRITABLE.includes(message.status)) throw new UserFacingError(ALREADY_SENT);

  const db = await getDb();
  // Conditional on the status again: it may have changed since the read above.
  const updated = await db
    .update(outreachMessages)
    .set({ subject: subject || null, body, updatedAt: new Date() })
    .where(and(eq(outreachMessages.id, message.id), inArray(outreachMessages.status, REWRITABLE)))
    .returning();
  if (!updated.length) throw new UserFacingError(ALREADY_SENT);
}
