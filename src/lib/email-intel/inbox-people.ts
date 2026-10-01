/**
 * "From your inbox": the people an email names who are not in the user's network yet.
 *
 * `email_events.people` holds who each email named. P3 turns the ones already in the network
 * into Radar cards; this is the rest, offered so the user can add them with one press. It
 * reads at the page, never stores anything, and is the only place an unresolved person is
 * described, so every rule about who may be offered lives here and in `inbox-pick.ts`.
 *
 * ## Four reads, and only for an account that opted in
 *
 *  1. The last 21 days of events, with the opt-in check in the same statement (an account that
 *     has not opted in costs one statement and gets nothing), and the user's own Gmail address.
 *  2. `contact_identities`: an address a contact already holds is not a stranger, however the
 *     contact got it (a merge moves the identity rows, so this stays right after one).
 *  3. `contacts`, by name: someone who is already in the network under another address is not
 *     offered, because adding them again is how duplicates get made.
 *  4. `ignored_people`: someone the user dismissed is not offered again.
 *
 * Reads 3 and 4 run together. All of it is scoped by `user_id`.
 *
 * ## What leaves
 *
 * A name, a title, one model-written sentence about the email, its kind, and when. Never an
 * address (the key is the address, and it is the only thing a client sends back), a quote, or
 * a message. Nothing here is ever put in a prompt, an email, or the digest.
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { contacts, ignoredPeople } from "@/db/schema";
import { pickInboxCandidates, type InboxCandidate, type InboxEventKind, type InboxEventRow } from "./inbox-pick";
import { resolveEmails } from "./resolve";

export const INBOX_LOOKBACK_DAYS = 21;
/** Events read per load, newest first. */
export const INBOX_EVENTS = 50;
/** People kept before the name and dismissal checks. */
export const INBOX_CANDIDATES = 25;
/** People shown. */
export const INBOX_SHOWN = 5;

export type InboxPerson = {
  /** The normalized address. Opaque to the client; the add and dismiss actions take it back. */
  key: string;
  name: string;
  title: string | null;
  kind: InboxEventKind;
  summary: string;
  at: Date;
};

type EventRow = InboxEventRow & { own_address: string | null };

const DAY_MS = 86_400_000;

export async function loadInboxPeople(
  userId: string,
  now: Date = new Date(),
  opts: { limit?: number } = {}
): Promise<InboxPerson[]> {
  const db = await getDb();
  const rows = rowsOf<EventRow>(
    await db.execute(sql`
      SELECT e.id, e.kind, e.summary, e.occurred_at, e.people,
             (SELECT lower(g.email_address) FROM gmail_connections g WHERE g.user_id = e.user_id) AS own_address
        FROM email_events e
        JOIN user_settings s ON s.user_id = e.user_id AND s.email_intel_enabled = 1
       WHERE e.user_id = ${userId}
         AND e.dismissed_at IS NULL
         AND e.kind <> 'other'
         AND jsonb_array_length(e.people) > 0
         AND e.occurred_at >= ${new Date(now.getTime() - INBOX_LOOKBACK_DAYS * DAY_MS)}
       ORDER BY e.occurred_at DESC, e.id
       LIMIT ${INBOX_EVENTS}
    `)
  );
  if (rows.length === 0) return [];

  const candidates = pickInboxCandidates(rows, rows[0]?.own_address ? [rows[0].own_address] : [], INBOX_CANDIDATES);
  if (candidates.length === 0) return [];

  const owned = await resolveEmails(userId, candidates.map((c) => c.key));
  const strangers = candidates.filter((c) => !owned.has(c.key));
  if (strangers.length === 0) return [];

  const names = [...new Set(strangers.map((c) => c.nameKey))];
  const [known, dismissed] = await Promise.all([
    db
      .select({
        name: sql<string>`lower(${contacts.fullName})`,
        preferred: sql<string>`lower(coalesce(${contacts.preferredName}, ''))`,
      })
      .from(contacts)
      .where(
        and(
          eq(contacts.userId, userId),
          or(
            inArray(sql`lower(${contacts.fullName})`, names),
            inArray(sql`lower(coalesce(${contacts.preferredName}, ''))`, names)
          )
        )
      ),
    db
      .select({ key: ignoredPeople.nameKey })
      .from(ignoredPeople)
      .where(and(eq(ignoredPeople.userId, userId), inArray(ignoredPeople.nameKey, names))),
  ]);
  const skip = new Set<string>([...known.flatMap((k) => [k.name, k.preferred]), ...dismissed.map((d) => d.key)]);

  return strangers
    .filter((c) => !skip.has(c.nameKey))
    .slice(0, opts.limit ?? INBOX_SHOWN)
    .map(toPerson);
}

function toPerson(c: InboxCandidate): InboxPerson {
  return { key: c.key, name: c.name, title: c.title, kind: c.kind, summary: c.summary, at: c.at };
}

/** One offered person by key, searched across every candidate rather than just the five shown. */
export async function findInboxPerson(userId: string, key: string, now: Date = new Date()): Promise<InboxPerson | null> {
  if (typeof key !== "string" || key.length === 0 || key.length > 254) return null;
  const all = await loadInboxPeople(userId, now, { limit: INBOX_CANDIDATES });
  return all.find((p) => p.key === key) ?? null;
}
