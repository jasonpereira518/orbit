import { and, asc, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { shareCards, userSettings } from "@/db/schema";
import { isAdminUser } from "@/lib/admin";
import { loadPublicCardForOwner, publicCardFromRows, type PublicCard } from "@/lib/cards/card-store";
import { attendedEventFilter } from "@/lib/events/store";
import { isDiscoverable } from "@/lib/nearby/discoverability";
import { isSurfaceReleased } from "@/lib/surface-visibility";

/** What another user sees about you: your public card, minus who you are in Orbit's tables. */
export type AlsoHerePerson = Omit<PublicCard, "ownerId" | "slug">;
export type AlsoHere = { findable: boolean; people: AlsoHerePerson[] };
/** `AlsoHere` plus the viewer's own state, for the event page card — read once, not twice. */
export type AlsoHereDetail = AlsoHere & { discoverable: boolean; hasCard: boolean; hiddenHere: boolean };

const SURFACE = "feature.also-here";
const MAX_PEOPLE = 20;
const MAX_CANDIDATES = 50;

/** Live: started, and not past its end (or 3 h after start when it has none). Expects alias `e`. */
const liveAt = (now: Date) =>
  sql`(e.starts_at <= ${now} AND ${now} <= COALESCE(e.ends_at, e.starts_at + interval '3 hours'))`;

const isUuid = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

/**
 * Whether this is one of the user's attended events and it is live now. Unlike `liveEventFor`,
 * which picks ONE event (the latest start), this is true for every overlapping live event —
 * the "Orbit people here" card, and its hide control, must show on each one the user is
 * findable at.
 */
export async function isLiveAttendedEvent(userId: string, eventId: string, now: Date = new Date()): Promise<boolean> {
  if (!isUuid(eventId)) return false;
  const db = await getDb();
  const res = await db.execute(sql`
    SELECT 1 FROM events e
    WHERE e.id = ${eventId} AND e.user_id = ${userId}
      AND ${attendedEventFilter()} AND ${liveAt(now)}
    LIMIT 1`);
  return res.rows.length > 0;
}

/**
 * Other Orbit users at the same live event as the viewer, matched on a shared event key:
 * the platform id (`luma:evt-…`), the canonical URL, or the calendar invite UID (`gcal:` and
 * `ics:` alike). Reciprocal: a viewer who isn't findable here sees nobody.
 */
export async function alsoHereFor(viewerId: string, eventId: string, now: Date = new Date()): Promise<AlsoHere> {
  const { findable, people } = await alsoHereDetail(viewerId, eventId, now);
  return { findable, people };
}

export async function alsoHereDetail(viewerId: string, eventId: string, now: Date = new Date()): Promise<AlsoHereDetail> {
  const db = await getDb();
  const [ownRows, discoverable, viewerCard, cardReleased, hereReleased] = await Promise.all([
    isUuid(eventId)
      ? db
          .execute(sql`
            SELECT e.discovery_hidden_at IS NOT NULL AS hidden FROM events e
            WHERE e.id = ${eventId} AND e.user_id = ${viewerId}
              AND ${attendedEventFilter()} AND ${liveAt(now)}
            LIMIT 1`)
          .then((r) => r.rows as Array<{ hidden: boolean }>)
      : Promise.resolve([] as Array<{ hidden: boolean }>),
    isDiscoverable(viewerId),
    loadPublicCardForOwner(viewerId),
    // Release flags are global rows (only an admin's own override differs), so they are read
    // once here rather than once per matched person.
    isSurfaceReleased(viewerId, "page.card"),
    isSurfaceReleased(viewerId, SURFACE),
  ]);
  const hiddenHere = ownRows[0]?.hidden === true;
  const base = { discoverable, hasCard: !!viewerCard, hiddenHere };
  const viewerFindable =
    ownRows.length > 0 && !hiddenHere && discoverable && !!viewerCard && (hereReleased || isAdminUser(viewerId));
  if (!viewerFindable) return { ...base, findable: false, people: [] };

  const keyRows = (
    await db.execute(sql`
      SELECT kind, value FROM event_aliases
      WHERE event_id = ${eventId} AND user_id = ${viewerId}`)
  ).rows as Array<{ kind: string; value: string }>;
  const providers = keyRows.filter((k) => k.kind === "provider").map((k) => k.value);
  const urls = keyRows.filter((k) => k.kind === "url").map((k) => k.value);
  const uids = keyRows
    .filter((k) => k.kind === "source_ref" && /^(gcal|ics):/.test(k.value))
    .map((k) => k.value.slice(k.value.indexOf(":") + 1));

  const list = (values: string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);
  const matches: SQL[] = [];
  if (providers.length) matches.push(sql`(a.kind = 'provider' AND a.value IN (${list(providers)}))`);
  if (urls.length) matches.push(sql`(a.kind = 'url' AND a.value IN (${list(urls)}))`);
  if (uids.length) {
    matches.push(sql`(a.kind = 'source_ref' AND (a.value LIKE 'gcal:%' OR a.value LIKE 'ics:%')
      AND substring(a.value from position(':' in a.value) + 1) IN (${list(uids)}))`);
  }
  if (!matches.length) return { ...base, findable: true, people: [] };

  // Candidates who could actually be shown — a live (unpaused) card, opted in, not suspended —
  // so paused cards never use up the candidate limit. Ordered so the cut is stable.
  const ids = (
    await db.execute(sql`
      SELECT DISTINCT a.user_id FROM event_aliases a
      JOIN events e ON e.id = a.event_id
      JOIN user_settings us ON us.user_id = a.user_id
      JOIN share_cards s ON s.user_id = a.user_id AND s.paused_at IS NULL
      WHERE a.user_id <> ${viewerId}
        AND a.event_id IS NOT NULL
        AND (${sql.join(matches, sql` OR `)})
        AND ${attendedEventFilter()} AND ${liveAt(now)}
        AND e.discovery_hidden_at IS NULL
        AND us.discoverable_at IS NOT NULL
        AND us.suspended_at IS NULL
      ORDER BY a.user_id
      LIMIT ${MAX_CANDIDATES}`)
  ).rows.map((r) => (r as { user_id: string }).user_id);
  if (!ids.length) return { ...base, findable: true, people: [] };

  // One read for every candidate's card and owner row, instead of a round of queries each.
  const rows = await db
    .select({ card: shareCards, owner: userSettings })
    .from(shareCards)
    .innerJoin(userSettings, sql`${userSettings.userId} = ${shareCards.userId}`)
    .where(and(inArray(shareCards.userId, ids), isNull(shareCards.pausedAt), isNull(userSettings.suspendedAt)))
    .orderBy(asc(shareCards.userId));

  const people = rows
    .filter(({ owner }) => (cardReleased || isAdminUser(owner.userId)) && (hereReleased || isAdminUser(owner.userId)))
    .map(({ card, owner }) => publicCardFromRows(card, owner))
    .filter((c): c is PublicCard => c !== null)
    .map(({ ownerId: _ownerId, slug: _slug, ...person }) => person)
    .sort((x, y) => x.fullName.localeCompare(y.fullName))
    .slice(0, MAX_PEOPLE);
  return { ...base, findable: true, people };
}
