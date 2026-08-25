"use server";

import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  recruiterMessages,
  recruiters,
  userGoals,
  userRecruiterLinks,
  type RecruiterMessage,
} from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { requireRecruitersUser, requireSyncUser } from "@/lib/plan-guards";
import { getCurrentUserProfile } from "@/lib/auth";
import { sendGmailMessage } from "@/lib/gmail-send";
import { gmailConnections } from "@/db/schema";
import {
  generateRecruiterDraftsBatch,
  isRecruiterIntent,
  type RecruiterIntent,
} from "@/lib/recruiter-drafts";
import {
  DAILY_RECRUITER_SEND_LIMIT,
  type RecruiterDraft,
  type SendDraftsResult,
} from "@/lib/recruiter-message-types";

/** Spacing between sends in a batch, so an approved batch trickles rather than bursts. */
const SEND_SPACING_MS = 1200;

function toDraft(
  row: RecruiterMessage,
  recruiter: { fullName: string; firm: string | null; email: string | null }
): RecruiterDraft {
  return {
    id: row.id,
    recruiterId: row.recruiterId,
    recruiterName: recruiter.fullName,
    recruiterFirm: recruiter.firm,
    recruiterEmail: recruiter.email,
    intent: row.intent as RecruiterIntent,
    subject: row.subject,
    body: row.body,
    status: row.status,
    errorMessage: row.errorMessage,
  };
}

async function countSendsToday(userId: string) {
  const db = await getDb();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(recruiterMessages)
    .where(
      and(
        eq(recruiterMessages.userId, userId),
        eq(recruiterMessages.status, "sent"),
        gte(recruiterMessages.sentAt, start)
      )
    );
  return rows[0]?.count ?? 0;
}

export async function getRecruiterSendQuota() {
  const userId = await requireUserId();
  const used = await countSendsToday(userId);
  return {
    used,
    limit: DAILY_RECRUITER_SEND_LIMIT,
    remaining: Math.max(0, DAILY_RECRUITER_SEND_LIMIT - used),
  };
}

/**
 * Generate one draft per selected recruiter and persist them as `draft` rows.
 *
 * Nothing is sent here. Drafts are stored rather than held in component state so a
 * reload mid-review does not lose a batch that cost real tokens to produce.
 */
export async function generateRecruiterDrafts(
  recruiterIds: string[],
  intent: string
): Promise<RecruiterDraft[]> {
  const userId = await requireRecruitersUser();
  if (!isRecruiterIntent(intent)) throw new Error("Unknown message intent");
  const ids = Array.from(new Set(recruiterIds.filter(Boolean)));
  if (ids.length === 0) throw new Error("Select at least one recruiter");
  if (ids.length > DAILY_RECRUITER_SEND_LIMIT) {
    throw new Error(
      `Draft at most ${DAILY_RECRUITER_SEND_LIMIT} at a time — that is the daily send limit.`
    );
  }

  const db = await getDb();

  // Only recruiters this user has actually logged: drafting needs the private history,
  // and a pool recruiter you have no relationship with has none to draw on.
  const links = await db.query.userRecruiterLinks.findMany({
    where: and(
      eq(userRecruiterLinks.userId, userId),
      inArray(userRecruiterLinks.recruiterId, ids)
    ),
    with: { recruiter: true },
  });
  if (links.length === 0) {
    throw new Error("You have not logged any of the selected recruiters");
  }

  const goals = await db.query.userGoals.findMany({
    where: and(eq(userGoals.userId, userId), eq(userGoals.active, 1)),
  });
  const goalTexts = goals.map((g) => g.text.trim()).filter(Boolean);

  const profile = await getCurrentUserProfile().catch(() => null);
  const senderName = profile?.name?.trim() || null;

  const drafts = await generateRecruiterDraftsBatch(
    userId,
    links.map((link) => ({
      intent,
      recruiter: {
        fullName: link.recruiter.fullName,
        firm: link.recruiter.firm,
        specialty: link.recruiter.specialty || [],
      },
      history: link.aiSummary,
      companiesMentioned: link.companiesMentioned || [],
      rolesDiscussed: link.rolesDiscussed || [],
      lastEmailAt: link.lastEmailAt,
      userGoals: goalTexts,
      senderName,
    }))
  );

  const created: RecruiterDraft[] = [];
  for (let i = 0; i < links.length; i += 1) {
    const draft = drafts[i];
    if (!draft || "error" in draft) continue;
    const [row] = await db
      .insert(recruiterMessages)
      .values({
        userId,
        recruiterId: links[i].recruiterId,
        intent,
        subject: draft.subject,
        body: draft.body,
        status: "draft",
        gmailThreadId: links[i].gmailThreadId,
      })
      .returning();
    created.push(toDraft(row, links[i].recruiter));
  }

  if (created.length === 0) {
    throw new Error("Every draft failed to generate. Check your AI provider key.");
  }

  revalidatePath("/recruiters/compose");
  return created;
}

export async function listRecruiterDrafts(): Promise<RecruiterDraft[]> {
  const userId = await requireRecruitersUser();
  const db = await getDb();
  const rows = await db
    .select({ message: recruiterMessages, recruiter: recruiters })
    .from(recruiterMessages)
    .innerJoin(recruiters, eq(recruiters.id, recruiterMessages.recruiterId))
    .where(
      and(
        eq(recruiterMessages.userId, userId),
        eq(recruiterMessages.status, "draft")
      )
    )
    .orderBy(asc(recruiterMessages.createdAt));
  return rows.map((r) => toDraft(r.message, r.recruiter));
}

export async function updateRecruiterDraft(
  id: string,
  patch: { subject?: string; body?: string }
) {
  const userId = await requireRecruitersUser();
  const db = await getDb();
  await db
    .update(recruiterMessages)
    .set({
      ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(recruiterMessages.id, id),
        eq(recruiterMessages.userId, userId),
        eq(recruiterMessages.status, "draft")
      )
    );
  revalidatePath("/recruiters/compose");
}

export async function discardRecruiterDrafts(ids: string[]) {
  const userId = await requireRecruitersUser();
  if (ids.length === 0) return;
  const db = await getDb();
  await db
    .delete(recruiterMessages)
    .where(
      and(
        eq(recruiterMessages.userId, userId),
        eq(recruiterMessages.status, "draft"),
        inArray(recruiterMessages.id, ids)
      )
    );
  revalidatePath("/recruiters/compose");
}

/**
 * Send the selected drafts through the user's Gmail, one at a time.
 *
 * Sequential and spaced on purpose. The alternative — firing them concurrently — is
 * both a deliverability risk and a worse failure mode, since a mid-batch quota rejection
 * would leave an unknown number of messages in flight.
 */
export async function sendRecruiterDrafts(
  ids: string[]
): Promise<SendDraftsResult> {
  const userId = await requireSyncUser();
  await requireRecruitersUser();
  const db = await getDb();

  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) throw new Error("Select at least one draft to send");

  const used = await countSendsToday(userId);
  const remaining = DAILY_RECRUITER_SEND_LIMIT - used;
  if (remaining <= 0) {
    throw new Error(
      `You've hit today's limit of ${DAILY_RECRUITER_SEND_LIMIT} recruiter emails. Try again tomorrow.`
    );
  }
  if (unique.length > remaining) {
    throw new Error(
      `You can send ${remaining} more today (limit ${DAILY_RECRUITER_SEND_LIMIT}). Deselect ${unique.length - remaining}.`
    );
  }

  // Resolve the sending identity once, not per message: every email in a batch must
  // leave from the same address, and re-reading it mid-batch could straddle a reconnect.
  const conn = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
  });
  if (!conn || conn.status !== "active") {
    throw new Error("Connect Gmail before sending.");
  }
  const profile = await getCurrentUserProfile().catch(() => null);
  const from = { name: profile?.name?.trim() || null, email: conn.emailAddress };

  const rows = await db
    .select({ message: recruiterMessages, recruiter: recruiters })
    .from(recruiterMessages)
    .innerJoin(recruiters, eq(recruiters.id, recruiterMessages.recruiterId))
    .where(
      and(
        eq(recruiterMessages.userId, userId),
        eq(recruiterMessages.status, "draft"),
        inArray(recruiterMessages.id, unique)
      )
    )
    .orderBy(asc(recruiterMessages.createdAt));

  const failed: SendDraftsResult["failed"] = [];
  let sent = 0;

  for (const [index, row] of rows.entries()) {
    const to = row.recruiter.email;
    if (!to) {
      failed.push({
        id: row.message.id,
        recruiterName: row.recruiter.fullName,
        error: "No email address on file",
      });
      continue;
    }

    try {
      const result = await sendGmailMessage(userId, {
        to,
        from,
        subject: row.message.subject,
        body: row.message.body,
        threadId: row.message.gmailThreadId,
      });
      await db
        .update(recruiterMessages)
        .set({
          status: "sent",
          sentAt: new Date(),
          gmailMessageId: result.gmailMessageId,
          gmailThreadId: result.gmailThreadId ?? row.message.gmailThreadId,
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(recruiterMessages.id, row.message.id));
      sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Send failed";
      await db
        .update(recruiterMessages)
        .set({
          status: "failed",
          errorMessage: message.slice(0, 500),
          updatedAt: new Date(),
        })
        .where(eq(recruiterMessages.id, row.message.id));
      failed.push({
        id: row.message.id,
        recruiterName: row.recruiter.fullName,
        error: message,
      });
    }

    if (index < rows.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, SEND_SPACING_MS));
    }
  }

  revalidatePath("/recruiters/compose");
  revalidatePath("/recruiters");
  return {
    sent,
    failed,
    quotaRemaining: Math.max(0, DAILY_RECRUITER_SEND_LIMIT - used - sent),
  };
}

/** Sent history for a single recruiter's detail page. */
export async function listRecruiterMessageHistory(
  recruiterId: string
): Promise<RecruiterMessage[]> {
  const userId = await requireRecruitersUser();
  const db = await getDb();
  return db.query.recruiterMessages.findMany({
    where: and(
      eq(recruiterMessages.userId, userId),
      eq(recruiterMessages.recruiterId, recruiterId)
    ),
    orderBy: [desc(recruiterMessages.createdAt)],
    limit: 20,
  });
}
