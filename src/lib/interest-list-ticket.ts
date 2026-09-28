/**
 * The read model behind the waitlist's early-access pass: a row's place in line, its
 * referrals, its planet, and the page's proof line.
 *
 * THE LINE (`lineSql`). Only people still waiting count (`unsubscribed_at IS NULL`). Each
 * person's join rank is their place by `(created_at, id)`; each still-waiting friend they
 * referred takes `SPOTS_PER_REFERRAL` off it, and the line is that score. A tie goes to
 * whoever has more referrals, then to join order: that is what makes a referral move you up
 * exactly 5 places, since landing on someone's score puts you ahead of them, not behind. So a place moves up as your friends join and as people ahead leave, and
 * down when someone behind you refers enough friends to pass you.
 *
 * Server-only. Imports `@/db` and, from the framework, only React's `cache` — nothing from
 * `next/*` — so the join core and the smoke scripts can call it outside a request, where
 * `cache()` is a pass-through. The proof memo is module-level rather than
 * `unstable_cache` for the same reason — that helper needs Next's request store, and its
 * companion `revalidateTag(tag)` is deprecated in Next 16 — and because per-instance is
 * the right scope: a second instance lagging a join by up to a minute changes nothing a
 * visitor can act on.
 */
import { cache } from "react";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { interestListSignups } from "@/db/schema";
import {
  INTEREST_LIST_COUNT_FLOOR,
  SPOTS_PER_REFERRAL,
  slugFromEmail,
  slugWithSuffix,
  type InterestTicket,
} from "@/lib/interest-list";
import { asWelcomePlanet, type WelcomePlanet } from "@/lib/welcome-planets";

export type InterestProof = {
  /** People on the waitlist now — what the proof line shows, and the line's length. */
  count: number;
  /** Every row ever inserted — the population the join ordinals (and planets) come from. */
  total: number;
  /** The last three planets handed out, newest first. */
  recent: WelcomePlanet[];
};

export type SignupRowForTicket = {
  id: string;
  email: string;
  /** Null for a row that has never had a ticket read; `ticketForRow` claims one. */
  referralSlug: string | null;
  createdAt: Date;
  welcomePlanet: string | null;
  shareToken: string;
};

const countInt = sql<number>`count(*)::int`;

/** Postgres unique_violation, as either driver (PGlite, Neon) surfaces it, cause included. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/**
 * Gives a row its referral slug: the address's local part, or that with `-2`, `-3`, … when
 * another address already holds it. Idempotent — a row that has one keeps it, since links
 * already sent must never change.
 *
 * The free suffix is read, then written under the unique index, so two simultaneous claims
 * of one local part cannot both win: the loser gets a unique violation and reads again.
 * A handful of attempts is far more than a real collision needs; past that the error is
 * thrown, and the ticket read that asked (which the join catches) falls back to the token link.
 */
export async function claimReferralSlug(row: { id: string; email: string }): Promise<string> {
  const db = await getDb();
  const base = slugFromEmail(row.email);
  for (let attempt = 0; attempt < 5; attempt++) {
    const [current] = await db
      .select({ slug: interestListSignups.referralSlug })
      .from(interestListSignups)
      .where(eq(interestListSignups.id, row.id))
      .limit(1);
    if (current?.slug) return current.slug;

    // Every slug that could collide: `base` itself and `base-<n>`. LIKE's `_` also matches
    // any one character, which only over-reads — the check below is exact.
    const taken = new Set(
      (
        await db
          .select({ slug: interestListSignups.referralSlug })
          .from(interestListSignups)
          .where(
            or(
              eq(interestListSignups.referralSlug, base),
              sql`${interestListSignups.referralSlug} LIKE ${`${base}-%`}`
            )
          )
      ).map((r) => r.slug)
    );
    let n = 1;
    while (taken.has(slugWithSuffix(base, n))) n++;
    const candidate = slugWithSuffix(base, n);

    try {
      const [claimed] = await db
        .update(interestListSignups)
        // `IS NULL` again: a concurrent read of the same row may have claimed one already.
        .set({ referralSlug: candidate })
        .where(and(eq(interestListSignups.id, row.id), isNull(interestListSignups.referralSlug)))
        // Bare, not `.returning({...})`: an explicit selector defeats Drizzle's overloads here.
        .returning();
      if (claimed?.referralSlug) return claimed.referralSlug;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new Error("could not claim a referral slug");
}

/**
 * Ordinal by (created_at, id): rows inserted in the same instant still get distinct
 * numbers. `id` is a uuid, so `<=` orders it arbitrarily but stably — which is all a
 * tie-break needs.
 */
export async function ticketForRow(row: SignupRowForTicket): Promise<InterestTicket> {
  const db = await getDb();
  const [[ordinal], standing, referralSlug] = await Promise.all([
    db
      .select({ n: countInt })
      .from(interestListSignups)
      .where(
        or(
          lt(interestListSignups.createdAt, row.createdAt),
          and(
            eq(interestListSignups.createdAt, row.createdAt),
            sql`${interestListSignups.id} <= ${row.id}::uuid`
          )
        )
      ),
    standingFor(row),
    row.referralSlug ?? claimReferralSlug(row),
  ]);
  return {
    number: Math.max(1, ordinal?.n ?? 1),
    position: standing.position,
    referrals: standing.referrals,
    planet: asWelcomePlanet(row.welcomePlanet),
    joinedAt: row.createdAt.toISOString(),
    shareToken: row.shareToken,
    referralSlug,
  };
}

export type Standing = {
  position: number;
  referrals: number;
  /** Place by join order alone, among the people still waiting — what `position` would be with no referrals. */
  joinRank: number;
};

/**
 * The whole line, in one statement: every waiting row's referrals and its place.
 *
 * `refs` counts each referrer's still-waiting referrals (one GROUP BY over the
 * `referred_by_id` index); `join_rank` is the place by join order, and `position` orders by
 * that rank less `SPOTS_PER_REFERRAL` per referral, ties to the person with more referrals
 * and then to join order. This is THE definition of the line — the pass (`standingFor`)
 * and the admin roster (`readStandings`) both read it, so they cannot disagree about
 * anyone's place.
 */
function lineSql(only: string | null) {
  return sql`
    WITH refs AS (
      SELECT referred_by_id AS id, count(*)::int AS n
      FROM interest_list_signups
      WHERE referred_by_id IS NOT NULL AND unsubscribed_at IS NULL
      GROUP BY referred_by_id
    ),
    joined AS (
      SELECT
        s.id,
        s.created_at,
        COALESCE(refs.n, 0) AS referrals,
        row_number() OVER (ORDER BY s.created_at, s.id) AS join_rank
      FROM interest_list_signups s
      LEFT JOIN refs ON refs.id = s.id
      WHERE s.unsubscribed_at IS NULL
    ),
    line AS (
      SELECT
        id,
        referrals,
        join_rank,
        row_number() OVER (
          ORDER BY (join_rank - ${SPOTS_PER_REFERRAL}::int * referrals), referrals DESC, created_at, id
        ) AS position
      FROM joined
    )
    SELECT id, referrals, join_rank, position FROM line
    ${only ? sql`WHERE id = ${only}::uuid` : sql``}
  `;
}

type LineRow = {
  id: string;
  referrals: number | string;
  join_rank: number | string;
  position: number | string;
};

function toStanding(row: LineRow): Standing {
  return {
    position: Math.max(1, Number(row.position)),
    referrals: Number(row.referrals),
    joinRank: Math.max(1, Number(row.join_rank)),
  };
}

/**
 * One row's place in line and live referral count. A row that has left the waitlist has
 * no place; callers only ask about waiting rows, and for anything else this answers the
 * back of the line rather than inventing a spot in it.
 */
export async function standingFor(row: { id: string }): Promise<Standing> {
  const db = await getDb();
  const [found] = rowsOf<LineRow>(await db.execute(lineSql(row.id)));
  if (found) return toStanding(found);
  const [waiting] = await db
    .select({ n: countInt })
    .from(interestListSignups)
    .where(isNull(interestListSignups.unsubscribedAt));
  const back = (waiting?.n ?? 0) + 1;
  return { position: back, referrals: 0, joinRank: back };
}

/** Every waiting row's standing, keyed by id — for the admin roster and its export. */
export async function readStandings(): Promise<Map<string, Standing>> {
  const db = await getDb();
  const rows = rowsOf<LineRow>(await db.execute(lineSql(null)));
  return new Map(rows.map((r) => [r.id, toStanding(r)]));
}

/**
 * Wrapped in React's `cache` so `generateMetadata` and the page body, which both resolve
 * the same `?me=` token, share one lookup per request. Outside a request — the join core,
 * the smoke scripts — `cache()` is a pass-through, so nothing else changes.
 */
export const getTicketByShareToken = cache(
  async (token: string): Promise<InterestTicket | null> => {
    if (!token) return null;
    const db = await getDb();
    const [row] = await db
      .select({
        id: interestListSignups.id,
        email: interestListSignups.email,
        referralSlug: interestListSignups.referralSlug,
        createdAt: interestListSignups.createdAt,
        welcomePlanet: interestListSignups.welcomePlanet,
        shareToken: interestListSignups.shareToken,
      })
      .from(interestListSignups)
      // Someone who left the waitlist has no pass: their old link shows the form, and
      // joining again restores their row (and their place) through the rejoin branch.
      .where(and(eq(interestListSignups.shareToken, token), isNull(interestListSignups.unsubscribedAt)))
      .limit(1);
    if (!row?.shareToken) return null;
    return ticketForRow({ ...row, shareToken: row.shareToken });
  }
);

export type ProgressSnapshot = { referrals: number; position: number };

const PROGRESS_TTL_MS = 5_000;
const PROGRESS_MEMO_MAX = 500;
const progressMemo = new Map<string, { at: number; value: ProgressSnapshot | null }>();

/**
 * What the tracker's poll reads: a pass's live referral count and place, or null when the
 * token names nobody still waiting. `standingFor` ranks the whole line, so answers are
 * held for five seconds per token — a referrer watching their pass costs one line read per
 * five seconds however many tabs they have open. Per-instance, like the proof memo.
 */
export async function getProgressByShareToken(token: string): Promise<ProgressSnapshot | null> {
  if (!token) return null;
  const hit = progressMemo.get(token);
  if (hit && Date.now() - hit.at < PROGRESS_TTL_MS) return hit.value;
  const db = await getDb();
  const [row] = await db
    .select({ id: interestListSignups.id })
    .from(interestListSignups)
    .where(and(eq(interestListSignups.shareToken, token), isNull(interestListSignups.unsubscribedAt)))
    .limit(1);
  const value = row
    ? await standingFor(row).then((s) => ({ referrals: s.referrals, position: s.position }))
    : null;
  if (progressMemo.size >= PROGRESS_MEMO_MAX) progressMemo.clear();
  progressMemo.set(token, { at: Date.now(), value });
  return value;
}

/** Called by the join core once a referral is credited, so the referrer's next poll sees it. */
export function invalidateProgress(token: string) {
  progressMemo.delete(token);
}

/** The row a `ref` names: by slug (always lowercase) or by share token (case-sensitive). */
export function refMatch(ref: string) {
  return or(eq(interestListSignups.referralSlug, ref.toLowerCase()), eq(interestListSignups.shareToken, ref));
}

/**
 * The planet on the ticket a `?ref=` link points at, for the invited strip. `ref` is a
 * referral slug (`/waitlist/<slug>`) or, on links sent before slugs, a share token.
 */
export async function getInviterPlanet(ref: string): Promise<WelcomePlanet | null> {
  if (!ref) return null;
  const db = await getDb();
  const [row] = await db
    .select({ welcomePlanet: interestListSignups.welcomePlanet })
    .from(interestListSignups)
    .where(refMatch(ref))
    .limit(1);
  return row ? asWelcomePlanet(row.welcomePlanet) : null;
}

/** Uncached. Two counts, one three-row read. */
export async function readInterestProof(): Promise<InterestProof> {
  const db = await getDb();
  const [[totals], recentRows] = await Promise.all([
    db
      .select({
        total: countInt,
        waiting: sql<number>`count(*) FILTER (WHERE ${interestListSignups.unsubscribedAt} IS NULL)::int`,
      })
      .from(interestListSignups),
    db
      .select({ planet: interestListSignups.welcomePlanet })
      .from(interestListSignups)
      .orderBy(desc(interestListSignups.createdAt), desc(interestListSignups.id))
      .limit(3),
  ]);
  return {
    count: totals?.waiting ?? 0,
    total: totals?.total ?? 0,
    recent: recentRows.map((r) => asWelcomePlanet(r.planet)),
  };
}

const PROOF_TTL_MS = 60_000;
let proofMemo: { at: number; value: InterestProof } | null = null;

/** The proof line, at most a minute stale. */
export async function getInterestProof(): Promise<InterestProof> {
  if (proofMemo && Date.now() - proofMemo.at < PROOF_TTL_MS) return proofMemo.value;
  const value = await readInterestProof();
  proofMemo = { at: Date.now(), value };
  return value;
}

/** Called by the join core after an insert so the next visitor sees the new count. */
export function invalidateInterestProof() {
  proofMemo = null;
}

/**
 * How long between two opens of the same pass before the second counts as a new check.
 * Short enough that a day later still registers; long enough that a refresh, React
 * Strict Mode double-mount, or the post-join `?me=` rewrite cannot double-count one visit.
 */
const PASS_CHECK_DEBOUNCE_MS = 30 * 60 * 1000;

/**
 * Records that someone opened their own waitlist pass in a real browser.
 *
 * Client-only on purpose: SSR/`after()` and email link prefetch would count an admin-added
 * welcome email (or a crawler) as a check. The boarding pass mounts in the browser and
 * calls this once; never from the join write, the progress poll, or the admin add path.
 *
 * Failures are swallowed by callers; a missed count must never fail the page or the join.
 */
export async function recordPassCheck(shareToken: string): Promise<void> {
  if (!shareToken) return;
  const db = await getDb();
  const cutoff = new Date(Date.now() - PASS_CHECK_DEBOUNCE_MS);
  await db
    .update(interestListSignups)
    .set({
      passCheckCount: sql`${interestListSignups.passCheckCount} + 1`,
      passLastCheckedAt: sql`now()`,
    })
    .where(
      and(
        eq(interestListSignups.shareToken, shareToken),
        isNull(interestListSignups.unsubscribedAt),
        or(isNull(interestListSignups.passLastCheckedAt), lt(interestListSignups.passLastCheckedAt, cutoff))
      )
    );
}

export function proofShowsCount(proof: Pick<InterestProof, "count">) {
  return proof.count >= INTEREST_LIST_COUNT_FLOOR;
}
