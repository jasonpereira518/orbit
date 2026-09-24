/**
 * The waitlist's share funnel: invite links opened, share controls used, passes asked for
 * by email. `interest_list_events` holds the first three; joins through a link are already
 * `interest_list_signups.referred_by_id`, so the funnel reads both tables.
 *
 * Server-only (`@/db`). Writes never throw — the funnel is the least important thing a
 * visitor's action touches, and nothing they do may fail because of it.
 */
import { and, count, eq, gte, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { interestListEvents, interestListSignups } from "@/db/schema";
import { SHARE_CHANNELS, type InterestEventKind, type ShareChannel } from "@/lib/interest-list";

export async function recordInterestEvent(event: {
  kind: InterestEventKind;
  channel?: ShareChannel | null;
  /** The pass the event is about, by id… */
  signupId?: string | null;
  /** …or by its share token, resolved here. An unknown token records nothing. */
  shareToken?: string | null;
}): Promise<void> {
  try {
    const db = await getDb();
    let signupId = event.signupId ?? null;
    if (!signupId && event.shareToken) {
      const [row] = await db
        .select({ id: interestListSignups.id })
        .from(interestListSignups)
        .where(eq(interestListSignups.shareToken, event.shareToken))
        .limit(1);
      if (!row) return;
      signupId = row.id;
    }
    await db.insert(interestListEvents).values({
      kind: event.kind,
      channel: event.channel ?? null,
      signupId,
    });
  } catch (err) {
    console.error("[interest-list] event not recorded", err);
  }
}

export type InterestFunnel = {
  days: number;
  /** Invite links opened by a person (bots are dropped at the beacon). */
  arrivals: number;
  /** Signups that came in through someone's link. */
  referredJoins: number;
  /** All signups in the window, for scale. */
  joins: number;
  /** Share controls used, by channel, busiest first. */
  shares: Array<{ channel: ShareChannel; n: number }>;
  passRequests: number;
};

/** The funnel over the last `days` days. */
export async function readInterestFunnel(days = 30): Promise<InterestFunnel> {
  const db = await getDb();
  const since = sql`now() - make_interval(days => ${days})`;
  const [[events], [signups], shareRows] = await Promise.all([
    db
      .select({
        arrivals: sql<number>`count(*) filter (where ${interestListEvents.kind} = 'ref_arrival')::int`,
        passRequests: sql<number>`count(*) filter (where ${interestListEvents.kind} = 'pass_request')::int`,
      })
      .from(interestListEvents)
      .where(gte(interestListEvents.createdAt, since)),
    db
      .select({
        joins: sql<number>`count(*)::int`,
        referredJoins: sql<number>`count(${interestListSignups.referredById})::int`,
      })
      .from(interestListSignups)
      .where(gte(interestListSignups.createdAt, since)),
    db
      .select({ channel: interestListEvents.channel, n: count() })
      .from(interestListEvents)
      .where(
        and(
          eq(interestListEvents.kind, "share_click"),
          isNotNull(interestListEvents.channel),
          gte(interestListEvents.createdAt, since)
        )
      )
      .groupBy(interestListEvents.channel),
  ]);
  const known = new Set<string>(SHARE_CHANNELS);
  return {
    days,
    arrivals: events?.arrivals ?? 0,
    passRequests: events?.passRequests ?? 0,
    joins: signups?.joins ?? 0,
    referredJoins: signups?.referredJoins ?? 0,
    shares: shareRows
      .filter((r): r is { channel: ShareChannel; n: number } => known.has(r.channel ?? ""))
      .map((r) => ({ channel: r.channel, n: Number(r.n) }))
      .sort((a, b) => b.n - a.n),
  };
}
