/**
 * Reading and writing `event_aliases` — the table that decides "have we seen this before".
 *
 * Every statement here is batched over a whole pass's worth of keys. On `neon-http` each
 * statement is its own HTTPS request with no pipelining, so round-trip count IS runtime: a
 * calendar page of 250 events would otherwise be 250 lookups before a single row is written.
 *
 * No `next/*` imports — the sync pass and the smoke scripts both load this. See `store.ts`.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { eventAliases, events } from "@/db/schema";
import type { AliasKey } from "@/lib/events/discovery/types";
import { keyId } from "@/lib/events/discovery/keys";

/** What one key currently resolves to. */
export type AliasResolution = {
  eventId: string | null;
  /** The key is known and points at nothing: the event was deleted, or never wanted. */
  tombstoned: boolean;
  /** The key points at an event the user has hidden. */
  dismissed: boolean;
};

const UNKNOWN: AliasResolution = { eventId: null, tombstoned: false, dismissed: false };

/**
 * Resolve many keys in one statement.
 *
 * Returns a map from `keyId` so callers can ask about each key they hold without caring which
 * of them (if any) the database had.
 */
export async function resolveAliases(
  userId: string,
  keys: AliasKey[]
): Promise<Map<string, AliasResolution>> {
  const out = new Map<string, AliasResolution>();
  if (keys.length === 0) return out;
  const db = await getDb();

  const pairs = keys.map((key) => sql`(${key.kind}, ${key.value})`);
  const rows = rowsOf<{
    kind: string;
    value: string;
    event_id: string | null;
    dismissed_at: string | Date | null;
    /** Null when the alias is a tombstone: there is no event row to join to. */
    event_exists: boolean | null;
  }>(
    await db.execute(sql`
      SELECT a.kind, a.value, a.event_id, e.dismissed_at,
             (e.id IS NOT NULL) AS event_exists
        FROM event_aliases a
        LEFT JOIN events e ON e.id = a.event_id AND e.user_id = ${userId}
       WHERE a.user_id = ${userId}
         AND (a.kind, a.value) IN (${sql.join(pairs, sql`, `)})
    `)
  );

  for (const row of rows) {
    out.set(keyId({ kind: row.kind as AliasKey["kind"], value: row.value }), {
      // An alias pointing at an event that is gone (or at another user's, which the join
      // refuses) is a tombstone, not a link.
      eventId: row.event_exists ? row.event_id : null,
      tombstoned: !row.event_exists,
      dismissed: Boolean(row.dismissed_at),
    });
  }
  return out;
}

/** The strongest verdict across a candidate's keys. */
export function combineResolutions(
  keys: AliasKey[],
  known: Map<string, AliasResolution>
): AliasResolution {
  let out = UNKNOWN;
  for (const key of keys) {
    const hit = known.get(keyId(key));
    if (!hit) continue;
    // A live event wins outright: attaching to it is always better than refusing.
    if (hit.eventId && !hit.dismissed) return hit;
    if (hit.eventId && hit.dismissed) out = hit;
    else if (hit.tombstoned && !out.eventId) out = hit;
  }
  return out;
}

/**
 * Point a set of keys at one event, in a single statement.
 *
 * `ON CONFLICT` updates `last_seen_at` rather than doing nothing, so a feed that keeps
 * reporting an event keeps its alias fresh — which is what makes a stale alias meaningful
 * later if we ever want to expire them.
 *
 * `event_id` is only ever moved onto a NEWER event when the caller says so (`repoint`). A
 * background sync must not steal a key away from the event a user is already looking at; an
 * explicit paste may, because that is the user telling us they want this one.
 */
export async function upsertEventAliases(
  userId: string,
  eventId: string | null,
  keys: AliasKey[],
  source: string,
  options: { evidence?: Record<string, unknown>; repoint?: boolean } = {}
): Promise<void> {
  if (keys.length === 0) return;
  const db = await getDb();
  const evidence = JSON.stringify(options.evidence ?? {});

  const values = keys.map(
    (key) =>
      sql`(${userId}, ${key.kind}, ${key.value}, ${eventId}::uuid, ${source}, ${evidence}::jsonb)`
  );

  await db.execute(sql`
    INSERT INTO event_aliases (user_id, kind, value, event_id, source, evidence)
    VALUES ${sql.join(values, sql`, `)}
    ON CONFLICT (user_id, kind, value) DO UPDATE SET
      event_id     = ${
        options.repoint
          ? sql`excluded.event_id`
          : sql`COALESCE(event_aliases.event_id, excluded.event_id)`
      },
      evidence     = CASE WHEN event_aliases.evidence = '{}'::jsonb
                          THEN excluded.evidence ELSE event_aliases.evidence END,
      last_seen_at = now()
  `);
}

/**
 * "Not mine" — hide the event, and remember that we were told to.
 *
 * A soft hide rather than a delete: the roster, and any connections made from it, are the
 * user's work and a mis-click must not destroy them. The remembering is the aliases, which
 * stay pointing at this row — without them the next sync of the same feed adds it straight
 * back, every fifteen minutes, forever.
 */
export async function dismissEventForUser(userId: string, eventId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(events)
    .set({ dismissedAt: new Date(), enrichDueAt: null, updatedAt: new Date() })
    .where(and(eq(events.id, eventId), eq(events.userId, userId)));
}

export async function restoreEventForUser(userId: string, eventId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(events)
    .set({ dismissedAt: null, updatedAt: new Date() })
    .where(and(eq(events.id, eventId), eq(events.userId, userId)));
}

/**
 * Tombstone every key that pointed at an event about to be deleted.
 *
 * `ON DELETE SET NULL` does this for us at the database level; this exists for the one case
 * the FK cannot cover — recording that the DELETE was deliberate before it happens, so a
 * concurrent discovery pass cannot re-create the row in the gap.
 */
export async function tombstoneAliasesForEvent(userId: string, eventId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(eventAliases)
    .set({ eventId: null, lastSeenAt: new Date() })
    .where(and(eq(eventAliases.userId, userId), eq(eventAliases.eventId, eventId)));
}

/** Keys that point at nothing at all. Used by the smoke tests and the "why is this hidden" UI. */
export async function listTombstones(userId: string, limit = 100) {
  const db = await getDb();
  return db.query.eventAliases.findMany({
    where: and(eq(eventAliases.userId, userId), isNull(eventAliases.eventId)),
    limit,
  });
}
