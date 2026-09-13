/**
 * The read model behind the /interest boarding pass: a row's ordinal, its planet, the
 * people it referred, and the page's proof line.
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
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { interestListSignups } from "@/db/schema";
import { INTEREST_LIST_COUNT_FLOOR, type InterestTicket } from "@/lib/interest-list";
import {
  asWelcomePlanet,
  planetForSignupNumber,
  type WelcomePlanet,
} from "@/lib/welcome-planets";

export type InterestProof = {
  /** Every row ever inserted — the population the ordinals are drawn from. */
  count: number;
  nextPlanet: WelcomePlanet;
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
  const [[ordinal], [moons]] = await Promise.all([
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
    db
      .select({ n: countInt })
      .from(interestListSignups)
      .where(eq(interestListSignups.referredById, row.id)),
  ]);
  return {
    number: Math.max(1, ordinal?.n ?? 1),
    planet: asWelcomePlanet(row.welcomePlanet),
    joinedAt: row.createdAt.toISOString(),
    moons: moons?.n ?? 0,
    shareToken: row.shareToken,
  };
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
      .where(eq(interestListSignups.shareToken, token))
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

/** Uncached. One count, one three-row read. */
export async function readInterestProof(): Promise<InterestProof> {
  const db = await getDb();
  const [[total], recentRows] = await Promise.all([
    db.select({ n: countInt }).from(interestListSignups),
    db
      .select({ planet: interestListSignups.welcomePlanet })
      .from(interestListSignups)
      .orderBy(desc(interestListSignups.createdAt), desc(interestListSignups.id))
      .limit(3),
  ]);
  const count = total?.n ?? 0;
  return {
    count,
    nextPlanet: planetForSignupNumber(count + 1),
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
