/**
 * Reading and claiming the rows in `contact_identities`.
 *
 * That table's `UNIQUE (user_id, kind, value)` is the only thing in Orbit that actually
 * prevents duplicate contacts. Everything in `src/lib/duplicates.ts` scores similarity
 * *after* the fact and can only ever be advisory, because a check followed by an insert is
 * two statements and two concurrent writers both pass the check. A unique index is one
 * statement, so exactly one writer wins and the other is told who won.
 *
 * Nothing outside this file may write to `contact_identities`, and nothing may compute an
 * identity value except `identityKeysFor`. Two spellings of "normalised" would let a
 * contact hold an identifier that a later lookup cannot find, which is a duplicate with
 * extra steps.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contactIdentities, contacts } from "@/db/schema";
import {
  addIdentityToIndex,
  identityKeysFor,
  type DuplicateIndex,
  type DuplicateSubject,
  type IdentityInput,
  type IdentityKey,
} from "@/lib/duplicates";

/** The contact that currently owns an identifier, as reported by the upsert. */
export type IdentityOwner = { key: IdentityKey; contactId: string };

/**
 * Which contacts already hold any of these identifiers.
 *
 * Read-only, so it is subject to the race the unique index exists to close: an owner can
 * appear between this call and a subsequent insert. Use it to *route* a write (and to
 * present a preview), never as the sole guard before creating a contact — `claimIdentities`
 * is the guard.
 */
export async function findIdentityOwners(
  userId: string,
  keys: IdentityKey[]
): Promise<IdentityOwner[]> {
  if (!keys.length) return [];
  const db = await getDb();
  const rows = await db
    .select({
      kind: contactIdentities.kind,
      value: contactIdentities.value,
      contactId: contactIdentities.contactId,
    })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.userId, userId),
        // One OR-of-pairs rather than `kind IN (...) AND value IN (...)`, which would
        // match an email whose text happens to equal some other contact's X handle.
        sql`(${sql.join(
          keys.map((k) => sql`(${contactIdentities.kind} = ${k.kind} AND ${contactIdentities.value} = ${k.value})`),
          sql` OR `
        )})`
      )
    );
  return rows.map((r) => ({
    key: { kind: r.kind, value: r.value },
    contactId: r.contactId,
  }));
}

/**
 * Claim every identifier for a contact, and report who actually holds each one.
 *
 * `ON CONFLICT ... DO UPDATE SET value = EXCLUDED.value` rather than `DO NOTHING`: a
 * `DO NOTHING ... RETURNING` returns no row on conflict, so the caller learns neither that
 * it lost nor who won, and would have to follow up with a second, racy SELECT. The no-op
 * update always returns a row, and the `contact_id` on it is the incumbent's whenever this
 * caller lost. One statement, one answer.
 *
 * Rows are inserted in `identityKeysFor` order — sorted by `(kind, value)`. That is
 * load-bearing: two concurrent statements touching the same two identifiers in opposite
 * order take each other's row locks and deadlock.
 *
 * A returned `contactId` different from `contactId` means this contact lost that
 * identifier to an existing one, and the caller must merge rather than keep both.
 */
export async function claimIdentities(
  userId: string,
  contactId: string,
  keys: IdentityKey[],
  source?: string
): Promise<IdentityOwner[]> {
  if (!keys.length) return [];
  const db = await getDb();
  const rows = await db
    .insert(contactIdentities)
    .values(
      keys.map((k) => ({
        userId,
        contactId,
        kind: k.kind,
        value: k.value,
        source: source ?? null,
      }))
    )
    .onConflictDoUpdate({
      target: [contactIdentities.userId, contactIdentities.kind, contactIdentities.value],
      // Deliberately a no-op write. The point is not the update, it is that DO UPDATE
      // makes the conflicting row visible to RETURNING while DO NOTHING does not.
      set: { value: sql`excluded.value` },
    })
    // Bare `.returning()`, not `.returning({ ... })` — an explicit field selector defeats
    // Drizzle's overload resolution after `.onConflictDoUpdate()` against the union `Db`
    // type (same trap noted in action-items.ts and import-engine.ts).
    .returning();
  return rows.map((r) => ({ key: { kind: r.kind, value: r.value }, contactId: r.contactId }));
}

/** Every identifier a contact currently holds. */
export async function identitiesForContact(userId: string, contactId: string) {
  const db = await getDb();
  return db
    .select({ kind: contactIdentities.kind, value: contactIdentities.value })
    .from(contactIdentities)
    .where(
      and(eq(contactIdentities.userId, userId), eq(contactIdentities.contactId, contactId))
    );
}

/** Drop identifiers a contact no longer carries (an email corrected, a LinkedIn URL fixed). */
export async function releaseIdentities(
  userId: string,
  contactId: string,
  keys: IdentityKey[]
) {
  if (!keys.length) return;
  const db = await getDb();
  await db.delete(contactIdentities).where(
    and(
      eq(contactIdentities.userId, userId),
      eq(contactIdentities.contactId, contactId),
      sql`(${sql.join(
        keys.map((k) => sql`(${contactIdentities.kind} = ${k.kind} AND ${contactIdentities.value} = ${k.value})`),
        sql` OR `
      )})`
    )
  );
}

/** Join a key into one comparable string. Same rationale as `compositeKey` in duplicates.ts. */
function keyToken(k: { kind: string; value: string }) {
  return `${k.kind}\u001f${k.value}`;
}

/**
 * Bring a contact's identity rows in line with an edit of its columns.
 *
 * Releases only what the edit replaced: the identifiers `previous` (the columns before the
 * write) carried that the new columns do not. A contact can own more identifiers than its
 * columns show (a second email from an address book, a phone from an import); those are not
 * the edit's to drop. Returns the owners reported by the claim, so a caller that has just
 * written a contact can see whether any identifier landed on somebody else.
 */
export async function syncIdentitiesForContact(
  userId: string,
  contactId: string,
  input: IdentityInput,
  source?: string,
  /** The columns before the write. Omitted: every row the columns don't carry is released. */
  previous?: IdentityInput
): Promise<IdentityOwner[]> {
  const wanted = identityKeysFor(input);
  const wantedSet = new Set(wanted.map(keyToken));
  const candidates = previous ? identityKeysFor(previous) : await identitiesForContact(userId, contactId);
  const stale = candidates
    .filter((k) => !wantedSet.has(keyToken(k)))
    .map((k) => ({ kind: k.kind, value: k.value }));
  if (stale.length) await releaseIdentities(userId, contactId, stale);
  return claimIdentities(userId, contactId, wanted, source);
}

/**
 * Add identifiers to contacts that already exist, in one statement; an identifier another
 * contact owns stays theirs (the pair is the duplicate review's to judge, not this write's).
 * Additive only: nothing is released. Sorted like `identityKeysFor` (deadlock order).
 */
export async function claimIdentitiesBulk(
  userId: string,
  claims: Array<{ contactId: string; keys: IdentityKey[] }>,
  source?: string
) {
  const rows = claims
    .flatMap((c) => c.keys.map((k) => ({ userId, contactId: c.contactId, kind: k.kind, value: k.value, source: source ?? null })))
    .sort((a, b) => (a.kind === b.kind ? (a.value < b.value ? -1 : 1) : a.kind < b.kind ? -1 : 1));
  if (!rows.length) return;
  const db = await getDb();
  await db.insert(contactIdentities).values(rows).onConflictDoNothing();
}

/**
 * File every contact in `existing` under the identifiers it owns beyond its columns, so an
 * import or sync matches a person by their second email or their phone too. One read.
 */
export async function indexStoredIdentities(userId: string, index: DuplicateIndex, existing: DuplicateSubject[]) {
  const byId = new Map(existing.map((c) => [c.id, c]));
  const db = await getDb();
  const rows = await db
    .select({ contactId: contactIdentities.contactId, kind: contactIdentities.kind, value: contactIdentities.value })
    .from(contactIdentities)
    .where(eq(contactIdentities.userId, userId));
  for (const r of rows) {
    const contact = byId.get(r.contactId);
    if (contact) addIdentityToIndex(index, r, contact);
  }
}

export type BackfillResult = {
  /** Contacts examined this run. */
  scanned: number;
  /** Identity rows successfully claimed. */
  claimed: number;
  /**
   * Contacts that carried an identifier another contact already held — the account's
   * pre-existing duplicates. The backfill itself does not merge them (it has no opinion
   * about confidence); `mergeConfidentDuplicates` runs afterwards and resolves the ones
   * that are unambiguous.
   */
  contested: string[];
  /** The users those contested contacts belong to, so a caller knows who to sweep. */
  contestedUserIds: string[];
  /** True when there is more to do; call again. */
  more: boolean;
};

/**
 * Populate `contact_identities` for contacts that have no rows yet.
 *
 * Runs in TypeScript rather than SQL so that `identityKeysFor` is the one and only
 * normalisation rule. A SQL backfill would be a second implementation of `linkedinSlug`,
 * `normalizeXHandle`, `isRoleEmail` and E.164 parsing, and the two would drift the first
 * time either changed — leaving contacts holding identifiers no lookup could find.
 *
 * Ordered by `created_at` so the *oldest* contact wins a contested identifier. That matters
 * for stability, not fairness: the backfill is resumable and may run across several deploys,
 * and an arbitrary order would let a rerun hand the same identifier to a different contact.
 * The same "older wins" rule governs merge direction in `contact-resolve.ts`.
 *
 * Bounded per call. This runs from the build (`scripts/migrate.ts`), and an unbounded
 * full-table pass over a large account would hold the deploy open.
 */
export async function backfillContactIdentities(options?: {
  userId?: string;
  limit?: number;
}): Promise<BackfillResult> {
  const limit = options?.limit ?? 2000;
  const db = await getDb();

  // Anti-join on the FK index. A contact with zero identity rows has not been processed;
  // one that produced no keys (no email, no LinkedIn, nothing) is re-examined on every run
  // and costs one row read, which is cheaper than a marker column on contacts.
  const pending = await db
    .select({
      id: contacts.id,
      userId: contacts.userId,
      email: contacts.email,
      phone: contacts.phone,
      linkedinUrl: contacts.linkedinUrl,
      xHandle: contacts.xHandle,
    })
    .from(contacts)
    .leftJoin(contactIdentities, eq(contactIdentities.contactId, contacts.id))
    .where(
      options?.userId
        ? and(isNull(contactIdentities.id), eq(contacts.userId, options.userId))
        : isNull(contactIdentities.id)
    )
    .orderBy(contacts.createdAt, contacts.id)
    .limit(limit);

  let claimed = 0;
  const contested: string[] = [];
  const contestedUserIds = new Set<string>();

  for (const row of pending) {
    const keys = identityKeysFor(row);
    if (!keys.length) continue;
    const owners = await claimIdentities(row.userId, row.id, keys, "backfill");
    for (const owner of owners) {
      if (owner.contactId === row.id) claimed += 1;
      else if (!contested.includes(row.id)) {
        contested.push(row.id);
        contestedUserIds.add(row.userId);
      }
    }
  }

  return {
    scanned: pending.length,
    claimed,
    contested,
    contestedUserIds: [...contestedUserIds],
    more: pending.length === limit,
  };
}
