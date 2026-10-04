"use server";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
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
import { requireRecruitersUser } from "@/lib/plan-guards";
import { getCurrentUserProfile } from "@/lib/auth";
import { loadWritingInstructions } from "@/lib/writing-instructions-store";
import "@/lib/email/origin-registrations";
import { ENQUEUE_COPY, chargeEmailBurst, dispatchEmailSend, enqueueEmail } from "@/lib/email/outbox";
import { getSendCapability } from "@/lib/email/sender";
import {
  generateRecruiterDraftsBatch,
  isRecruiterIntent,
  type RecruiterIntent,
} from "@/lib/recruiter-drafts";
import { RECRUITER_BATCH_LIMIT, type RecruiterDraft, type SendDraftsResult } from "@/lib/recruiter-message-types";
import { pooledIdsForViewer, resolveRecruiterPii } from "@/lib/recruiters";
import { ActionResult, asActionResult, UserFacingError } from "@/lib/errors";
import { isDemoWorkspace } from "@/lib/demo-workspace";

/** Spacing between sends in a batch, so an approved batch trickles rather than bursts. */
const SEND_SPACING_MS = 1200;

function toDraft(
  row: RecruiterMessage,
  recruiter: { fullName: string; firm: string | null },
  /** From `resolveRecruiterPii`: a draft never reveals an address its sender cannot see. */
  recruiterEmail: string | null
): RecruiterDraft {
  return {
    id: row.id,
    recruiterId: row.recruiterId,
    recruiterName: recruiter.fullName,
    recruiterFirm: recruiter.firm,
    recruiterEmail,
    intent: row.intent as RecruiterIntent,
    subject: row.subject,
    body: row.body,
    status: row.status,
    errorMessage: row.errorMessage,
  };
}

/** Recruiter email shares the one daily cap every 1:1 send counts against. */
export async function getRecruiterSendQuota() {
  const userId = await requireUserId();
  const capability = await getSendCapability(userId);
  return {
    used: capability.usedToday,
    limit: capability.dailyCap,
    remaining: capability.ok ? capability.remainingToday : Math.max(0, capability.dailyCap - capability.usedToday),
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
): Promise<ActionResult<RecruiterDraft[]>> {
  return asActionResult(async () => {
    const userId = await requireRecruitersUser();
    if (!isRecruiterIntent(intent)) throw new Error("Unknown message intent");
    const ids = Array.from(new Set(recruiterIds.filter(Boolean)));
    if (ids.length === 0) throw new UserFacingError("Pick at least one recruiter first");
    if (ids.length > RECRUITER_BATCH_LIMIT) {
      throw new UserFacingError(`Draft at most ${RECRUITER_BATCH_LIMIT} at a time`);
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
      throw new UserFacingError("None of those recruiters are logged yet — log them first");
    }

    const goals = await db.query.userGoals.findMany({
      where: and(eq(userGoals.userId, userId), eq(userGoals.active, 1)),
    });
    const goalTexts = goals.map((g) => g.text.trim()).filter(Boolean);

    const profile = await getCurrentUserProfile().catch(() => null);
    const senderName = profile?.name?.trim() || null;
    // Once per batch: the drafts share one sender.
    const writingInstructions = await loadWritingInstructions(userId);

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
        writingInstructions,
      }))
    );

    const pooled = await pooledIdsForViewer(userId, links.map((l) => l.recruiterId));

    // Every successful draft in one multi-row insert rather than one per recruiter. Rows
    // come back keyed by `recruiterId` — unique per user (`user_recruiter_links`), so
    // unique across `links` — rather than trusting RETURNING's order.
    const toInsert = links.flatMap((link, i) => {
      const draft = drafts[i];
      if (!draft || "error" in draft) return [];
      return [{ link, draft }];
    });
    const rows = toInsert.length
      ? await db
          .insert(recruiterMessages)
          .values(
            toInsert.map(({ link, draft }, slot) => ({
              userId,
              recruiterId: link.recruiterId,
              intent,
              subject: draft.subject,
              body: draft.body,
              status: "draft" as const,
              gmailThreadId: link.gmailThreadId,
              // One statement means one `now()` for every row; `listRecruiterDrafts` sorts
              // by `created_at`, so a microsecond per slot keeps the order these were
              // drafted in, as the per-row inserts did.
              createdAt: sql`now() + ${slot}::integer * interval '1 microsecond'`,
            }))
          )
          .returning()
      : [];
    const rowByRecruiter = new Map(rows.map((row) => [row.recruiterId, row]));

    const created: RecruiterDraft[] = [];
    for (const { link } of toInsert) {
      const row = rowByRecruiter.get(link.recruiterId);
      if (!row) continue;
      created.push(
        toDraft(
          row,
          link.recruiter,
          resolveRecruiterPii(link.recruiter, link, pooled.has(link.recruiterId)).email
        )
      );
    }

    if (created.length === 0) {
      throw new UserFacingError("None of the drafts came through — check your AI key in Settings");
    }

    revalidatePath("/recruiters/compose");
    return created;
  });
}

export async function listRecruiterDrafts(): Promise<RecruiterDraft[]> {
  const userId = await requireRecruitersUser();
  const db = await getDb();
  const rows = await db
    .select({ message: recruiterMessages, recruiter: recruiters, link: userRecruiterLinks })
    .from(recruiterMessages)
    .innerJoin(recruiters, eq(recruiters.id, recruiterMessages.recruiterId))
    .leftJoin(
      userRecruiterLinks,
      and(
        eq(userRecruiterLinks.recruiterId, recruiterMessages.recruiterId),
        eq(userRecruiterLinks.userId, recruiterMessages.userId)
      )
    )
    .where(
      and(
        eq(recruiterMessages.userId, userId),
        eq(recruiterMessages.status, "draft")
      )
    )
    .orderBy(asc(recruiterMessages.createdAt));
  const pooled = await pooledIdsForViewer(userId, rows.map((r) => r.recruiter.id));
  return rows.map((r) =>
    toDraft(r.message, r.recruiter, resolveRecruiterPii(r.recruiter, r.link, pooled.has(r.recruiter.id)).email)
  );
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
): Promise<ActionResult<SendDraftsResult>> {
  return asActionResult(async () => {
    // Recruiter tracking is the gate here and the only one. `requireSyncUser` ran first and
    // refused a free user with the sync denial — which Task 6 reworded to talk about calendar
    // subscriptions and event sources, and `asActionResult` now hands that text straight to
    // someone who pressed Send on a recruiter email. Sending from your own address is on every
    // plan per the spec, so the sync gate never belonged here.
    const userId = await requireRecruitersUser();
    const db = await getDb();

    const unique = Array.from(new Set(ids.filter(Boolean)));
    if (unique.length === 0) throw new UserFacingError("Pick at least one draft to send");

    const capability = await getSendCapability(userId);
    const remaining = Math.max(0, capability.dailyCap - capability.usedToday);
    if (remaining <= 0) {
      throw new UserFacingError(ENQUEUE_COPY.cap_reached);
    }
    if (unique.length > remaining) {
      throw new UserFacingError(`You can send ${remaining} more today. Deselect ${unique.length - remaining}`);
    }

    // The demo workspace has no Gmail grant to send with (`demo-workspace-connections.ts`),
    // and its recruiters are `.example` addresses the outbox would refuse as placeholders:
    // record the drafts as sent, deliver nothing.
    if (await isDemoWorkspace(userId)) {
      const marked = await db
        .update(recruiterMessages)
        .set({ status: "sent", sentAt: new Date(), errorMessage: null, updatedAt: new Date() })
        .where(
          and(
            eq(recruiterMessages.userId, userId),
            eq(recruiterMessages.status, "draft"),
            inArray(recruiterMessages.id, unique)
          )
        )
        .returning(); // bare: a field selector breaks over the Db union
      revalidatePath("/recruiters/compose");
      revalidatePath("/recruiters");
      return { sent: marked.length, failed: [], quotaRemaining: Math.max(0, remaining - marked.length) };
    }

    if (!capability.ok && capability.reason !== "cap_reached") {
      throw new UserFacingError(ENQUEUE_COPY[capability.reason]);
    }
    // One approved batch is one burst, not one per message; the daily cap counts each email.
    const limited = await chargeEmailBurst(userId);
    if (limited && !limited.ok) throw new UserFacingError(limited.message);
    const profile = await getCurrentUserProfile().catch(() => null);
    const fromName = profile?.name?.trim() || null;

    const rows = await db
      .select({ message: recruiterMessages, recruiter: recruiters, link: userRecruiterLinks })
      .from(recruiterMessages)
      .innerJoin(recruiters, eq(recruiters.id, recruiterMessages.recruiterId))
      .leftJoin(
        userRecruiterLinks,
        and(
          eq(userRecruiterLinks.recruiterId, recruiterMessages.recruiterId),
          eq(userRecruiterLinks.userId, recruiterMessages.userId)
        )
      )
      .where(
        and(
          eq(recruiterMessages.userId, userId),
          eq(recruiterMessages.status, "draft"),
          inArray(recruiterMessages.id, unique)
        )
      )
      .orderBy(asc(recruiterMessages.createdAt));
    // Only an address this user may read: their own link first, then the pool.
    const pooled = await pooledIdsForViewer(userId, rows.map((r) => r.recruiter.id));

    const failed: SendDraftsResult["failed"] = [];
    let sent = 0;

    for (const [index, row] of rows.entries()) {
      const to = resolveRecruiterPii(row.recruiter, row.link, pooled.has(row.recruiter.id)).email;
      if (!to) {
        failed.push({
          id: row.message.id,
          recruiterName: row.recruiter.fullName,
          error: `${row.recruiter.fullName} has no email address on file`,
        });
        continue;
      }

      const queued = await enqueueEmail(userId, {
        to: [to],
        subject: row.message.subject,
        bodyText: row.message.body,
        fromName,
        origin: "recruiter",
        originRef: row.message.id,
        idempotencyKey: `recruiter:${row.message.id}`,
        threadId: row.message.gmailThreadId,
        delayMs: 0,
        chargeBurst: false,
      });
      if (!queued.ok) {
        failed.push({ id: row.message.id, recruiterName: row.recruiter.fullName, error: queued.message });
        continue;
      }
      // Sent inline, one at a time, so the page can say what happened to each; the outbox
      // records the outcome on the draft row (`origin-hooks/recruiter.ts`).
      const outcome = await dispatchEmailSend(queued.id);
      if (outcome === "sent") {
        sent += 1;
      } else if (outcome === "retry") {
        failed.push({
          id: row.message.id,
          recruiterName: row.recruiter.fullName,
          error: `Gmail is slow — Orbit will keep trying to send to ${row.recruiter.fullName}.`,
        });
      } else {
        failed.push({
          id: row.message.id,
          recruiterName: row.recruiter.fullName,
          error: `Couldn’t send to ${row.recruiter.fullName} — try again?`,
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
      quotaRemaining: Math.max(0, remaining - sent),
    };
  });
}
