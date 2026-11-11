import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { isAdminUser } from "@/lib/admin";
import { loadPublicCardForOwner, type PublicCard } from "@/lib/cards/card-store";
import { attendedEventFilter } from "@/lib/events/store";
import { isDiscoverable } from "@/lib/nearby/discoverability";
import { isSurfaceReleased } from "@/lib/surface-visibility";

/** What another user sees about you: your public card, minus who you are in Orbit's tables. */
export type AlsoHerePerson = Omit<PublicCard, "ownerId" | "slug">;
export type AlsoHere = { findable: boolean; people: AlsoHerePerson[] };

const SURFACE = "feature.also-here";
const MAX_PEOPLE = 20;
const NOBODY: AlsoHere = { findable: false, people: [] };

/** Live: started, and not past its end (or 3 h after start when it has none). Expects alias `e`. */
const liveAt = (now: Date) =>
  sql`(e.starts_at <= ${now} AND ${now} <= COALESCE(e.ends_at, e.starts_at + interval '3 hours'))`;

/** Findable by others: a live card, and the feature released for them (or an admin). */
async function findableCard(userId: string): Promise<PublicCard | null> {
  const card = await loadPublicCardForOwner(userId);
  if (!card) return null;
  if (!(await isSurfaceReleased(userId, SURFACE)) && !isAdminUser(userId)) return null;
  return card;
}

/**
 * Other Orbit users at the same live event as the viewer, matched on a shared event key:
 * the platform id (`luma:evt-…`), the canonical URL, or the calendar invite UID (`gcal:` and
 * `ics:` alike). Reciprocal: a viewer who isn't findable here sees nobody.
 */
export async function alsoHereFor(viewerId: string, eventId: string, now: Date = new Date()): Promise<AlsoHere> {
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) return NOBODY;
  const db = await getDb();

  const own = await db.execute(sql`
    SELECT e.id FROM events e
    WHERE e.id = ${eventId} AND e.user_id = ${viewerId}
      AND ${attendedEventFilter()} AND ${liveAt(now)} AND e.discovery_hidden_at IS NULL
    LIMIT 1`);
  if (!own.rows.length) return NOBODY;
  if (!(await isDiscoverable(viewerId)) || !(await findableCard(viewerId))) return NOBODY;

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
  if (!matches.length) return { findable: true, people: [] };

  const others = (
    await db.execute(sql`
      SELECT DISTINCT a.user_id FROM event_aliases a
      JOIN events e ON e.id = a.event_id
      JOIN user_settings us ON us.user_id = a.user_id
      WHERE a.user_id <> ${viewerId}
        AND a.event_id IS NOT NULL
        AND (${sql.join(matches, sql` OR `)})
        AND ${attendedEventFilter()} AND ${liveAt(now)}
        AND e.discovery_hidden_at IS NULL
        AND us.discoverable_at IS NOT NULL
        AND us.suspended_at IS NULL
      LIMIT 50`)
  ).rows as Array<{ user_id: string }>;

  const cards = await Promise.all(others.map((o) => findableCard(o.user_id)));
  const people = cards
    .filter((c): c is PublicCard => c !== null)
    .map(({ ownerId: _ownerId, slug: _slug, ...person }) => person)
    .sort((x, y) => x.fullName.localeCompare(y.fullName))
    .slice(0, MAX_PEOPLE);
  return { findable: true, people };
}
