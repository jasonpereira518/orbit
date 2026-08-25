import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { feedback } from "@/db/schema";

/**
 * What users said about Orbit.
 *
 * THE ONE FREE-TEXT COLUMN AN OPERATOR CAN READ WITHOUT HESITATION. Everywhere else in
 * this schema, prose is a user writing about a third party who never signed up —
 * `contacts.notes`, `interactions.raw_notes`, chat transcripts. This table is the
 * inverse: a user writing about *Orbit*, addressed to whoever runs it. There is no privacy
 * question to answer here, which is exactly why it is worth having its own table rather
 * than living as a `kind` inside something more general.
 *
 * Three kinds, one table: they are read together ("what has anyone said lately?"), they
 * share a shape, and at this volume the verbatims matter far more than any per-kind
 * aggregate.
 */

export type FeedbackKind = "pmf" | "freeform" | "churn_reason";

/**
 * The Sean Ellis scale. Three points, not five or ten.
 *
 * The question is *"how would you feel if you could no longer use Orbit?"* and the only
 * number anyone acts on is the share answering "very disappointed" — the conventional
 * threshold is 40%. A finer scale would invite averaging, and the average of this scale
 * means nothing at all.
 */
export const PMF_SCORES = {
  veryDisappointed: 3,
  somewhatDisappointed: 2,
  notDisappointed: 1,
} as const;

export const PMF_LABELS: Record<number, string> = {
  3: "Very disappointed",
  2: "Somewhat disappointed",
  1: "Not disappointed",
};

/** Long enough to be a sentence, short enough not to be a document. */
const MAX_TEXT = 4000;

export async function recordFeedback(input: {
  userId: string;
  kind: FeedbackKind;
  score?: number | null;
  text?: string | null;
  context?: Record<string, unknown>;
}): Promise<void> {
  const text = input.text?.trim().slice(0, MAX_TEXT) || null;
  const score =
    input.kind === "pmf" && typeof input.score === "number"
      ? Math.min(Math.max(Math.round(input.score), 1), 3)
      : null;

  // Nothing to record. A blank freeform submission is a mis-click, not a data point.
  if (!text && score === null) return;

  try {
    const db = await getDb();
    await db.insert(feedback).values({
      userId: input.userId,
      kind: input.kind,
      score,
      text,
      context: input.context ?? {},
    });
  } catch {
    // Losing one response is better than showing an error to someone who just did us a
    // favour by answering.
  }
}

export type PmfSummary = {
  total: number;
  veryDisappointed: number;
  somewhatDisappointed: number;
  notDisappointed: number;
  /** Share answering "very disappointed", 0–100. Null below the floor — see below. */
  score: number | null;
  /** Responses needed before `score` is populated. */
  minimumResponses: number;
};

/**
 * Below this many responses, the percentage is not reported at all.
 *
 * Not caution for its own sake: with 4 responses the score can only be 0, 25, 50, 75 or
 * 100, so it moves 25 points on one reply and reads as a trend when it is a coin flip.
 * The verbatims are the signal at that volume, and returning null forces the UI to say so
 * rather than printing a number that invites a decision.
 */
export const PMF_MINIMUM_RESPONSES = 10;

export async function pmfSummary(since?: Date): Promise<PmfSummary> {
  const db = await getDb();
  const rows = await db
    .select({ score: feedback.score, n: sql<string>`count(*)` })
    .from(feedback)
    .where(
      since
        ? and(eq(feedback.kind, "pmf"), gte(feedback.createdAt, since))
        : eq(feedback.kind, "pmf")
    )
    .groupBy(feedback.score);

  const counts = new Map<number, number>();
  for (const r of rows) {
    if (r.score == null) continue;
    const n = Number(r.n);
    counts.set(r.score, Number.isFinite(n) ? n : 0);
  }

  const very = counts.get(3) ?? 0;
  const somewhat = counts.get(2) ?? 0;
  const not = counts.get(1) ?? 0;
  const total = very + somewhat + not;

  return {
    total,
    veryDisappointed: very,
    somewhatDisappointed: somewhat,
    notDisappointed: not,
    score:
      total >= PMF_MINIMUM_RESPONSES ? Math.round((very / total) * 100) : null,
    minimumResponses: PMF_MINIMUM_RESPONSES,
  };
}

/**
 * Recent responses, newest first.
 *
 * Returns the rows themselves rather than an aggregate, because at this scale reading
 * twelve sentences beats any chart that could be drawn from them.
 */
export async function recentFeedback(opts: { kind?: FeedbackKind; limit?: number } = {}) {
  const db = await getDb();
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200);

  const rows = opts.kind
    ? await db
        .select()
        .from(feedback)
        .where(eq(feedback.kind, opts.kind))
        .orderBy(desc(feedback.createdAt))
        .limit(limit)
    : await db
        .select()
        .from(feedback)
        .orderBy(desc(feedback.createdAt))
        .limit(limit);

  return rows;
}

/** Has this user already answered the PMF question? Used to ask at most once. */
export async function hasAnsweredPmf(userId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db
    .select({ id: feedback.id })
    .from(feedback)
    .where(and(eq(feedback.userId, userId), eq(feedback.kind, "pmf")))
    .limit(1);
  return row.length > 0;
}
