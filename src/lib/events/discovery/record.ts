/**
 * Turning discovered candidates into rows.
 *
 * ## The rule that keeps the plan cap honest
 *
 * This module writes `events`, `event_aliases` and `event_attendees`, and **never calls
 * `ingestEvents`**. Nobody becomes a contact from a discovery pass, exactly as
 * `src/lib/events/sync.ts` records for provider syncs. The user's calendar is not a list of
 * people they have agreed to add to their CRM, and a term's worth of lecture invites would
 * otherwise eat a free user's entire contact allowance overnight.
 *
 * ## Three outcomes, and the third is the interesting one
 *
 *   - **create** — a key we have never seen.
 *   - **attach** — a key that resolves to an event we already hold. Fills blanks only.
 *   - **suppress** — a key the user has already answered. "Not mine" and a hard delete both
 *     leave their keys behind (see `event_aliases`), and a sync that ignored them would add
 *     the same unwanted event back every fifteen minutes for ever. This is the single reason
 *     the alias table exists in the shape it does.
 *
 * No `next/*` imports: the sync pass runs this from a cron POST with no request.
 */
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import {
  combineResolutions,
  resolveAliases,
  upsertEventAliases,
} from "@/lib/events/discovery/aliases";
import { canonicalEventKey, candidateKeys, keyId } from "@/lib/events/discovery/keys";
import {
  emptyDiscoveryStats,
  type AliasKey,
  type DiscoveryCandidate,
  type DiscoveryStats,
} from "@/lib/events/discovery/types";
import { mergeCandidates } from "@/lib/events/discovery/keys";
import { attendeeIdentityKey } from "@/lib/events/identity";
import { upsertEventAttendees } from "@/lib/events/store";
import { resolveThemeColor } from "@/lib/events/theme";
import { UNTITLED_EVENT } from "@/lib/events/types";
import type { ParsedAttendee } from "@/lib/events/parse-roster";

export type RecordOptions = {
  /**
   * How many newly created events may be queued for a page read. The queue itself is bounded
   * per pass (`enrich-queue.ts`); this only stops one enormous calendar import from filling
   * it with a year of backlog before anything recent gets a turn.
   */
  maxEnrichQueued?: number;
};

/**
 * A URL as it might have been stored before aliases existed.
 *
 * The alias table is authoritative from now on, but every event added before this code shipped
 * has no aliases at all — and rediscovering all of them as duplicates would be a rotten first
 * impression of the feature. `scripts/backfill-event-aliases.ts` fixes the history; this
 * matches the rest in the meantime.
 */
function storedUrlVariants(key: string): string[] {
  const variants = new Set<string>([key]);
  if (key.startsWith("luma.com/")) variants.add(key.replace("luma.com/", "lu.ma/"));
  if (key.startsWith("lu.ma/")) variants.add(key.replace("lu.ma/", "luma.com/"));
  return [...variants];
}

async function findEventsByStoredUrl(
  userId: string,
  urlKeys: string[]
): Promise<Map<string, { id: string; dismissed: boolean }>> {
  const out = new Map<string, { id: string; dismissed: boolean }>();
  if (urlKeys.length === 0) return out;
  const db = await getDb();
  const lookup = urlKeys.flatMap(storedUrlVariants);

  // `IN (…)` with one placeholder per value rather than `= ANY($1)`: drizzle renders a JS
  // array as a parenthesised tuple, which Postgres reads as a row constructor and refuses
  // with 42809 ("op ANY/ALL (array) requires array on right side").
  const placeholders = sql.join(
    lookup.map((value) => sql`${value}`),
    sql`, `
  );
  const rows = rowsOf<{ id: string; url_key: string; dismissed_at: string | Date | null }>(
    await db.execute(sql`
      SELECT id,
             regexp_replace(regexp_replace(lower(url), '^https?://(www\\.)?', ''), '/+$', '')
               AS url_key,
             dismissed_at
        FROM events
       WHERE user_id = ${userId}
         AND url IS NOT NULL
         AND regexp_replace(regexp_replace(lower(url), '^https?://(www\\.)?', ''), '/+$', '')
             IN (${placeholders})
    `)
  );

  for (const row of rows) {
    // Fold back onto the canonical spelling so the caller can look up by its own key.
    for (const key of storedUrlVariants(row.url_key)) {
      if (!out.has(key)) out.set(key, { id: row.id, dismissed: Boolean(row.dismissed_at) });
    }
  }
  return out;
}

/** Calendar guests as roster rows. Anything unidentifiable is dropped: `identity_key` is NOT NULL. */
function toParsedAttendees(candidate: DiscoveryCandidate): ParsedAttendee[] {
  const out: ParsedAttendee[] = [];
  const seen = new Set<string>();
  for (const person of candidate.attendees) {
    const identityKey = attendeeIdentityKey(person);
    if (!identityKey || seen.has(identityKey)) continue;
    seen.add(identityKey);
    out.push({
      fullName: person.fullName,
      email: person.email,
      company: person.company,
      title: person.title,
      linkedinUrl: person.linkedinUrl,
      xHandle: person.xHandle,
      phone: person.phone,
      attendeeRole: person.attendeeRole ?? null,
      externalRef: person.externalRef,
      identityKey,
    });
  }
  return out;
}

async function writeGuests(
  userId: string,
  eventId: string,
  candidate: DiscoveryCandidate
): Promise<void> {
  const guests = toParsedAttendees(candidate);
  if (guests.length === 0) return;
  // Source `calendar`: these came off an invite the user was on, not from a guest list
  // anybody published. The badge has to say so — it is the difference between "the host
  // announced this person" and "you were both invited to the same thing".
  await upsertEventAttendees(userId, eventId, guests, "calendar");
}

async function createFromCandidate(
  userId: string,
  candidate: DiscoveryCandidate,
  queueEnrichment: boolean
): Promise<string> {
  const db = await getDb();
  const title = candidate.title?.trim() || UNTITLED_EVENT;
  const theme = resolveThemeColor({ seed: candidate.url ?? title });

  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`
      INSERT INTO events
        (user_id, title, starts_at, ends_at, timezone, venue, url, role, role_source, source,
         discovered_via, rsvp_status, theme_color, theme_source, enrich_due_at)
      VALUES
        (${userId}, ${title}, ${candidate.startsAt}, ${candidate.endsAt}, ${candidate.timezone},
         ${candidate.location}, ${candidate.url},
         ${candidate.roleHint ?? "attended"}, 'inferred', 'manual',
         ${candidate.source}, ${candidate.rsvpHint},
         ${theme.color}, ${theme.source},
         ${queueEnrichment && candidate.url ? sql`now()` : sql`NULL`})
      RETURNING id
    `)
  );
  return rows[0]!.id;
}

/**
 * Fill in what this report knows and the row does not.
 *
 * Strictly blanks-only for the user-visible fields, with one exception: `rsvp_status`, which
 * is the one fact that legitimately CHANGES. Someone moves from the waitlist to going, or
 * cancels, and the newest report is the true one.
 *
 * The role may be upgraded to `hosted`, but only over a role we inferred ourselves. A user who
 * has said "I attended this" must not be contradicted by a heuristic on the next sync.
 */
async function attachToEvent(
  userId: string,
  eventId: string,
  candidate: DiscoveryCandidate
): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    UPDATE events SET
      title          = CASE WHEN title = ${UNTITLED_EVENT} AND ${candidate.title}::text IS NOT NULL
                            THEN ${candidate.title} ELSE title END,
      starts_at      = COALESCE(starts_at, ${candidate.startsAt}),
      ends_at        = COALESCE(ends_at, ${candidate.endsAt}),
      timezone       = COALESCE(timezone, ${candidate.timezone}),
      venue          = COALESCE(venue, ${candidate.location}),
      url            = COALESCE(url, ${candidate.url}),
      discovered_via = COALESCE(discovered_via, ${candidate.source}),
      rsvp_status    = COALESCE(${candidate.rsvpHint}, rsvp_status),
      role           = CASE WHEN ${candidate.roleHint ?? null}::text = 'hosted'
                             AND COALESCE(role_source, 'inferred') <> 'user'
                            THEN 'hosted' ELSE role END,
      -- A link on an event that had none is worth reading, even though the row is not new.
      enrich_due_at  = CASE WHEN url IS NULL AND ${candidate.url}::text IS NOT NULL
                            THEN now() ELSE enrich_due_at END,
      updated_at     = now()
    WHERE id = ${eventId} AND user_id = ${userId}
  `);
}

export async function recordDiscoveryCandidates(
  userId: string,
  candidates: DiscoveryCandidate[],
  options: RecordOptions = {}
): Promise<DiscoveryStats> {
  const stats = emptyDiscoveryStats();
  if (candidates.length === 0) return stats;
  const maxEnrichQueued = options.maxEnrichQueued ?? 25;

  const merged = mergeCandidates(candidates);
  const keysFor = new Map<DiscoveryCandidate, AliasKey[]>();
  const allKeys: AliasKey[] = [];
  for (const candidate of merged) {
    const keys = candidateKeys(candidate);
    keysFor.set(candidate, keys);
    allKeys.push(...keys);
  }
  // Candidates with no key at all cannot be deduped, and an event nobody can recognise twice
  // is an event that will be created again on every single pass.
  const usable = merged.filter((candidate) => (keysFor.get(candidate) ?? []).length > 0);
  if (usable.length === 0) return stats;

  const known = await resolveAliases(userId, allKeys);
  const urlKeys = usable
    .map((candidate) => canonicalEventKey(candidate.url))
    .filter((key): key is string => key !== null);
  const byStoredUrl = await findEventsByStoredUrl(userId, urlKeys);

  for (const candidate of usable) {
    const keys = keysFor.get(candidate)!;
    const resolution = combineResolutions(keys, known);

    // Refused: the user has already answered this one.
    if (resolution.tombstoned || resolution.dismissed) {
      stats.suppressed++;
      // Keep the keys fresh anyway, so a source that changes its ref mid-life still lands on
      // the same tombstone rather than escaping it.
      await upsertEventAliases(userId, resolution.eventId, keys, candidate.source);
      continue;
    }

    let eventId = resolution.eventId;

    // Pre-alias history: an event the user added before this table existed.
    if (!eventId) {
      const urlKey = canonicalEventKey(candidate.url);
      const hit = urlKey ? byStoredUrl.get(urlKey) : undefined;
      if (hit?.dismissed) {
        stats.suppressed++;
        await upsertEventAliases(userId, hit.id, keys, candidate.source);
        continue;
      }
      eventId = hit?.id ?? null;
    }

    if (eventId) {
      await attachToEvent(userId, eventId, candidate);
      await upsertEventAliases(userId, eventId, keys, candidate.source, {
        evidence: candidate.evidence,
      });
      await writeGuests(userId, eventId, candidate);
      stats.attached++;
      continue;
    }

    const queueEnrichment = stats.enrichQueued < maxEnrichQueued;
    const created = await createFromCandidate(userId, candidate, queueEnrichment);
    const settled = await claimOrYield(userId, created, keys, candidate);
    if (settled === created) {
      stats.created++;
      if (queueEnrichment && candidate.url) stats.enrichQueued++;
    } else {
      stats.attached++;
    }
    await writeGuests(userId, settled, candidate);
    // Record what we now know for the next pass, whichever row won.
    known.set(keyId(keys[0]!), { eventId: settled, tombstoned: false, dismissed: false });
  }

  return stats;
}

/**
 * Claim the keys for a freshly created event, or stand down if another writer got there first.
 *
 * Two passes can run at once — the cron overlapping a user-triggered sync — and both can see
 * "no alias" for the same event microseconds apart. The unique index settles it; this is how
 * the loser notices and cleans up.
 *
 * A compensating delete rather than a transaction because `neon-http` has no interactive
 * transactions. It is safe precisely because the row is one statement old: nothing has been
 * attached to it, and the guests are written afterwards, onto whichever row survived.
 */
async function claimOrYield(
  userId: string,
  eventId: string,
  keys: AliasKey[],
  candidate: DiscoveryCandidate
): Promise<string> {
  const db = await getDb();
  const values = keys.map(
    (key) =>
      sql`(${userId}, ${key.kind}, ${key.value}, ${eventId}::uuid, ${candidate.source},
           ${JSON.stringify(candidate.evidence ?? {})}::jsonb)`
  );

  const claimed = rowsOf<{ kind: string; value: string }>(
    await db.execute(sql`
      INSERT INTO event_aliases (user_id, kind, value, event_id, source, evidence)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (user_id, kind, value) DO NOTHING
      RETURNING kind, value
    `)
  );

  if (claimed.length > 0) return eventId;

  // Every key was already taken: somebody else created this event between our lookup and our
  // insert. Find who, hand the work to them, and remove the row we had just made.
  const owner = combineResolutions(keys, await resolveAliases(userId, keys));
  if (!owner.eventId || owner.eventId === eventId) return eventId;

  await db.execute(sql`DELETE FROM events WHERE id = ${eventId} AND user_id = ${userId}`);
  return owner.eventId;
}

/**
 * Claim an event's keys on behalf of the user, overriding a tombstone.
 *
 * Pasting a link is an explicit statement — "I want this event" — and it outranks a previous
 * dismissal, which was only ever a statement about an automatic suggestion. Used by
 * `createEvent` and by enrichment once a page reveals the platform's own id.
 */
export async function claimEventAliases(
  userId: string,
  eventId: string,
  keys: AliasKey[],
  source: string
): Promise<void> {
  if (keys.length === 0) return;
  await upsertEventAliases(userId, eventId, keys, source, { repoint: true });
}

/** The keys an event already known to us should be recognised by. */
export function keysForEvent(input: {
  url: string | null;
  provider?: string | null;
  providerEventId?: string | null;
}): AliasKey[] {
  const keys: AliasKey[] = [];
  if (input.provider && input.providerEventId) {
    keys.push({ kind: "provider", value: `${input.provider}:${input.providerEventId}` });
  }
  const url = canonicalEventKey(input.url);
  if (url) keys.push({ kind: "url", value: url });
  return keys;
}
