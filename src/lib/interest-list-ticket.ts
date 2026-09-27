/**
 * The read model behind the waitlist's early-access pass: a row's place in line, its
 * referrals and front-wave standing, its planet, and the page's proof line.
 *
 * THE LINE (`lineSql`). Only people still waiting count (`unsubscribed_at IS NULL`).
 * Anyone with `FRONT_WAVE_REFERRALS` friends still on the list is in the front wave, and
 * the front wave goes first; within it and behind it, join order `(created_at, id)`
 * decides. So a place moves up as your friends join and as people ahead leave, and down
 * only when someone behind you reaches the front wave.
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
  FRONT_WAVE_REFERRALS,
  INTEREST_LIST_COUNT_FLOOR,
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
  createdAt: Date;
  welcomePlanet: string | null;
  shareToken: string;
};

const countInt = sql<number>`count(*)::int`;

/**
 * Ordinal by (created_at, id): rows inserted in the same instant still get distinct
 * numbers. `id` is a uuid, so `<=` orders it arbitrarily but stably — which is all a
 * tie-break needs.
 */
export async function ticketForRow(row: SignupRowForTicket): Promise<InterestTicket> {
  const db = await getDb();
  const [[ordinal], standing] = await Promise.all([
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
  ]);
  return {
    number: Math.max(1, ordinal?.n ?? 1),
    position: standing.position,
    referrals: standing.referrals,
    frontWave: standing.frontWave,
    planet: asWelcomePlanet(row.welcomePlanet),
    joinedAt: row.createdAt.toISOString(),
    shareToken: row.shareToken,
  };
}

export type Standing = { position: number; referrals: number; frontWave: boolean };

/**
 * The whole line, in one statement: every waiting row's referrals and its place.
 *
 * `refs` counts each referrer's still-waiting referrals (one GROUP BY over the
 * `referred_by_id` index); `row_number()` orders the front wave first, then join order.
 * This is THE definition of the line — the pass (`standingFor`) and the admin roster
 * (`readStandings`) both read it, so they cannot disagree about anyone's place.
 */
function lineSql(only: string | null) {
  return sql`
    WITH refs AS (
      SELECT referred_by_id AS id, count(*)::int AS n
      FROM interest_list_signups
      WHERE referred_by_id IS NOT NULL AND unsubscribed_at IS NULL
      GROUP BY referred_by_id
    ),
    line AS (
      SELECT
        s.id,
        COALESCE(refs.n, 0) AS referrals,
        row_number() OVER (
          ORDER BY (COALESCE(refs.n, 0) >= ${FRONT_WAVE_REFERRALS}) DESC, s.created_at, s.id
        ) AS position
      FROM interest_list_signups s
      LEFT JOIN refs ON refs.id = s.id
      WHERE s.unsubscribed_at IS NULL
    )
    SELECT id, referrals, position FROM line
    ${only ? sql`WHERE id = ${only}::uuid` : sql``}
  `;
}

type LineRow = { id: string; referrals: number | string; position: number | string };

function toStanding(row: LineRow): Standing {
  const referrals = Number(row.referrals);
  return {
    position: Math.max(1, Number(row.position)),
    referrals,
    frontWave: referrals >= FRONT_WAVE_REFERRALS,
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
  return { position: (waiting?.n ?? 0) + 1, referrals: 0, frontWave: false };
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

/** The planet on the ticket a `?ref=` link points at, for the invited strip. */
export async function getInviterPlanet(token: string): Promise<WelcomePlanet | null> {
  if (!token) return null;
  const db = await getDb();
  const [row] = await db
    .select({ welcomePlanet: interestListSignups.welcomePlanet })
    .from(interestListSignups)
    .where(eq(interestListSignups.shareToken, token))
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

export function proofShowsCount(proof: Pick<InterestProof, "count">) {
  return proof.count >= INTEREST_LIST_COUNT_FLOOR;
}
