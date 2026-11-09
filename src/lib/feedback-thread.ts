/**
 * The conversation on a feedback report, between the person who sent it and the operator.
 *
 * The report is the opening message (it stays on `feedback.text`); the thread OPENS when the
 * operator first replies. Before that the reporter can see their report and its status but
 * has nothing to answer, which is the point — the conversation starts when someone is there.
 *
 * Only `kind = 'freeform'` reports have a conversation. PMF and churn answers are a score and
 * a reason, not something anyone asked to talk about.
 *
 * Live on both sides: `/api/feedback/[id]/stream` pushes the thread over server-sent events
 * whenever it changes (see that route for how often, and the upgrade path).
 */

import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { creditGrants, feedback, feedbackMessages, userSettings } from "@/db/schema";
import { creditsToMicros } from "@/lib/credits/grants";
import { FEEDBACK_RECIPIENT } from "@/lib/feedback-report";
import { escapeHtml } from "@/lib/interest-list-email";

export type ThreadMessage = {
  id: string;
  author: "user" | "operator";
  body: string;
  /** Bonus credits this operator reply carried as a thank-you; the gift renders under it. */
  credits: number | null;
  createdAt: string;
};

export type FeedbackThread = {
  id: string;
  /** The report itself — the conversation's first message. */
  report: { text: string | null; createdAt: string; area: string | null };
  status: "new" | "triaged" | "resolved";
  thanksCredits: number | null;
  /** The thank-you has been unwrapped. False while there is a gift still waiting. */
  thanksSeen: boolean;
  messages: ThreadMessage[];
  /** The operator has replied, so the reporter can write back. */
  open: boolean;
};

/**
 * Read one conversation. `viewer` decides who may see it: the reporter (their own report
 * only) or the operator (any freeform report). Null when it isn't theirs or doesn't exist —
 * the caller turns that into a 404 rather than telling anyone it exists.
 */
export async function loadThread(
  feedbackId: string,
  viewer: { userId: string } | "operator"
): Promise<FeedbackThread | null> {
  if (!isUuid(feedbackId)) return null;
  const db = await getDb();
  const [entry] = await db
    .select({
      id: feedback.id,
      userId: feedback.userId,
      kind: feedback.kind,
      text: feedback.text,
      area: feedback.area,
      status: feedback.status,
      thanksCredits: feedback.thanksCredits,
      thanksSeenAt: feedback.thanksSeenAt,
      createdAt: feedback.createdAt,
    })
    .from(feedback)
    .where(eq(feedback.id, feedbackId))
    .limit(1);
  if (!entry || entry.kind !== "freeform") return null;
  if (viewer !== "operator" && entry.userId !== viewer.userId) return null;

  const rows = await db
    .select({
      id: feedbackMessages.id,
      author: feedbackMessages.author,
      body: feedbackMessages.body,
      credits: feedbackMessages.credits,
      createdAt: feedbackMessages.createdAt,
    })
    .from(feedbackMessages)
    .where(eq(feedbackMessages.feedbackId, feedbackId))
    .orderBy(asc(feedbackMessages.createdAt));

  return {
    id: entry.id,
    report: { text: entry.text, createdAt: entry.createdAt.toISOString(), area: entry.area },
    status: entry.status,
    thanksCredits: entry.thanksCredits,
    thanksSeen: entry.thanksSeenAt !== null,
    messages: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    open: rows.some((r) => r.author === "operator"),
  };
}

/** The viewer has seen everything up to now. The reporter can only mark their own report. */
export async function markThreadRead(feedbackId: string, side: "user" | "operator", userId?: string) {
  if (!isUuid(feedbackId)) return;
  const db = await getDb();
  if (side === "user") {
    if (!userId) return;
    await db
      .update(feedback)
      .set({ userReadAt: new Date() })
      .where(and(eq(feedback.id, feedbackId), eq(feedback.userId, userId)));
    return;
  }
  await db.update(feedback).set({ operatorReadAt: new Date() }).where(eq(feedback.id, feedbackId));
}

/**
 * Add one message. The reporter may only write once the thread is open, and only on their own
 * report; the caller has already checked the operator is an operator.
 *
 * Writing counts as reading: whoever just sent a message has seen the thread up to it.
 * Returns null when the message isn't allowed (or the report is gone).
 */
export async function postThreadMessage(input: {
  feedbackId: string;
  author: "user" | "operator";
  body: string;
  /** Required for the reporter: their own id, checked against the report's owner. */
  userId?: string;
  /** Operator only: the thank-you credits this reply carries (already granted). */
  credits?: number | null;
}): Promise<{ reporterId: string; report: string | null } | null> {
  if (!isUuid(input.feedbackId)) return null;
  const db = await getDb();
  const [entry] = await db
    .select({ userId: feedback.userId, kind: feedback.kind, text: feedback.text })
    .from(feedback)
    .where(eq(feedback.id, input.feedbackId))
    .limit(1);
  if (!entry || entry.kind !== "freeform") return null;

  if (input.author === "user") {
    if (!input.userId || entry.userId !== input.userId) return null;
    const [operatorMessage] = await db
      .select({ id: feedbackMessages.id })
      .from(feedbackMessages)
      .where(and(eq(feedbackMessages.feedbackId, input.feedbackId), eq(feedbackMessages.author, "operator")))
      .limit(1);
    if (!operatorMessage) return null;
  }

  await db.insert(feedbackMessages).values({
    feedbackId: input.feedbackId,
    userId: entry.userId,
    author: input.author,
    body: input.body,
    credits: input.author === "operator" ? (input.credits ?? null) : null,
  });
  await markThreadRead(input.feedbackId, input.author, entry.userId);
  return { reporterId: entry.userId, report: entry.text };
}

/**
 * Unwrap the thank-you: stamp it seen, once, on the reporter's own report. Returns the
 * credits it carried, or null when there was nothing of theirs to unwrap (idempotent — a
 * second call still returns the credits, so a double tap can't lose the reveal).
 */
export async function unwrapThanks(feedbackId: string, userId: string): Promise<number | null> {
  if (!isUuid(feedbackId)) return null;
  const db = await getDb();
  const [row] = await db
    .select({ credits: feedback.thanksCredits, seenAt: feedback.thanksSeenAt })
    .from(feedback)
    .where(and(eq(feedback.id, feedbackId), eq(feedback.userId, userId)))
    .limit(1);
  if (!row || row.credits == null) return null;
  if (!row.seenAt) {
    await db
      .update(feedback)
      .set({ thanksSeenAt: new Date() })
      .where(and(eq(feedback.id, feedbackId), eq(feedback.userId, userId)));
  }
  return row.credits;
}

/**
 * Thank the reporter with bonus AI credits, at most once per report.
 *
 * An `adjustment` grant keyed `adj:feedback:<id>`: usable on every plan, spent after the
 * allowance and starter, and NOT cash — so no `amountCents`/`stripeRef` and no
 * `billing_events` row (see the billing ledger rule in `billing-stripe.ts`). Returns whether
 * this call made the grant; `thanks_credits` is set only then.
 */
export async function grantFeedbackThanks(input: {
  feedbackId: string;
  userId: string;
  credits: number;
}): Promise<boolean> {
  const db = await getDb();
  const micros = creditsToMicros(input.credits);
  const created = await db
    .insert(creditGrants)
    .values({
      userId: input.userId,
      kind: "adjustment",
      grantKey: `adj:feedback:${input.feedbackId}`,
      microsGranted: micros,
      microsRemaining: micros,
    })
    .onConflictDoNothing({ target: creditGrants.grantKey })
    .returning();
  if (created.length === 0) return false;
  await db
    .update(feedback)
    .set({ thanksCredits: input.credits })
    .where(eq(feedback.id, input.feedbackId));
  return true;
}

export type UnreadReply = {
  feedbackId: string;
  /** The newest operator message the reporter hasn't seen. */
  latest: string;
  at: Date;
  thanksCredits: number | null;
  /** A thank-you is waiting to be unwrapped on this report. */
  giftWaiting: boolean;
};

/** The reporter's conversations with an operator message they haven't opened yet. */
export async function unreadRepliesFor(userId: string): Promise<UnreadReply[]> {
  const db = await getDb();
  const rows = await db
    .select({
      feedbackId: feedbackMessages.feedbackId,
      body: feedbackMessages.body,
      at: feedbackMessages.createdAt,
      thanksCredits: feedback.thanksCredits,
      thanksSeenAt: feedback.thanksSeenAt,
      // The gift card lives on a message; a report credited without one has nothing to open.
      giftCredits: feedbackMessages.credits,
    })
    .from(feedbackMessages)
    .innerJoin(feedback, eq(feedback.id, feedbackMessages.feedbackId))
    .where(
      and(
        eq(feedbackMessages.userId, userId),
        eq(feedbackMessages.author, "operator"),
        gt(feedbackMessages.createdAt, sql`coalesce(${feedback.userReadAt}, 'epoch'::timestamptz)`)
      )
    )
    .orderBy(desc(feedbackMessages.createdAt))
    .limit(50);

  // Newest message per report: the query is already newest-first.
  const latest = new Map<string, UnreadReply>();
  for (const r of rows) {
    const known = latest.get(r.feedbackId);
    if (known) {
      // An older unread reply may be the one carrying the gift.
      if (r.giftCredits != null && r.thanksSeenAt === null) known.giftWaiting = true;
      continue;
    }
    latest.set(r.feedbackId, {
      feedbackId: r.feedbackId,
      latest: r.body,
      at: r.at,
      thanksCredits: r.thanksCredits,
      giftWaiting: r.giftCredits != null && r.thanksSeenAt === null,
    });
  }
  return [...latest.values()];
}

export type MyFeedbackRow = {
  id: string;
  excerpt: string;
  createdAt: Date;
  status: "new" | "triaged" | "resolved";
  thanksCredits: number | null;
  replies: number;
  unread: boolean;
  /** A thank-you is waiting to be unwrapped. */
  giftWaiting: boolean;
};

/** The reporter's own reports, newest first, for "Your feedback". */
export async function listMyFeedback(userId: string, limit = 20): Promise<MyFeedbackRow[]> {
  const db = await getDb();
  return db
    .select({
      id: feedback.id,
      excerpt: sql<string>`left(coalesce(${feedback.text}, ''), 140)`,
      createdAt: feedback.createdAt,
      status: feedback.status,
      thanksCredits: feedback.thanksCredits,
      // Spelled out rather than interpolated: inside a correlated subquery in `.select()`,
      // Drizzle renders `${feedback.id}` unqualified and the subquery would compare the inner
      // table to itself (the unqualified-column trap).
      replies: sql<number>`(select count(*)::int from feedback_messages m where m.feedback_id = feedback.id and m.author = 'operator')`,
      // Only a gift with a card to open: a reply has to carry it (spelled out — see above).
      giftWaiting: sql<boolean>`(feedback.thanks_seen_at is null and exists (select 1 from feedback_messages m where m.feedback_id = feedback.id and m.credits is not null))`,
      unread: sql<boolean>`exists (select 1 from feedback_messages m where m.feedback_id = feedback.id and m.author = 'operator' and m.created_at > coalesce(feedback.user_read_at, 'epoch'::timestamptz))`,
    })
    .from(feedback)
    .where(and(eq(feedback.userId, userId), eq(feedback.kind, "freeform")))
    .orderBy(desc(feedback.createdAt))
    .limit(limit);
}

/** Who sent a report. */
export async function reporterOf(feedbackId: string): Promise<string | null> {
  if (!isUuid(feedbackId)) return null;
  const db = await getDb();
  const [row] = await db
    .select({ userId: feedback.userId })
    .from(feedback)
    .where(eq(feedback.id, feedbackId))
    .limit(1);
  return row?.userId ?? null;
}

/** The reporter's address, when the operator wants the reply emailed too. */
export async function reporterEmail(userId: string): Promise<string | null> {
  const db = await getDb();
  const [row] = await db
    .select({ email: userSettings.email })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  return row?.email ?? null;
}

/** The emailed copy of a reply. Pure, so the smoke can pin it. */
export function buildFeedbackReplyEmail(input: {
  reply: string;
  report: string | null;
  credits: number | null;
  threadUrl: string;
}): { subject: string; html: string; text: string } {
  const creditsLine = input.credits
    ? `I've also added ${input.credits} bonus AI credits to your account as a thank-you.`
    : null;
  const quoted = (input.report ?? "").trim().slice(0, 600);
  const text = [
    input.reply,
    creditsLine,
    `Reply in Orbit: ${input.threadUrl}`,
    `— ${FEEDBACK_RECIPIENT}`,
    quoted ? `\nYou wrote:\n> ${quoted.split("\n").join("\n> ")}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  const para = (s: string) =>
    `<p style="margin:0 0 16px;line-height:1.55">${escapeHtml(s).replace(/\n/g, "<br>")}</p>`;
  const html = [
    `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;color:#1b2430;max-width:560px">`,
    para(input.reply),
    creditsLine ? para(creditsLine) : "",
    `<p style="margin:0 0 16px"><a href="${escapeHtml(input.threadUrl)}" style="color:#0f766e">Reply in Orbit</a></p>`,
    para(`— ${FEEDBACK_RECIPIENT}`),
    quoted
      ? `<blockquote style="margin:24px 0 0;padding-left:12px;border-left:3px solid #d5dbe1;color:#5b6673">${escapeHtml(quoted).replace(/\n/g, "<br>")}</blockquote>`
      : "",
    `</div>`,
  ].join("");
  return { subject: `${FEEDBACK_RECIPIENT} replied to your feedback`, html, text };
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
