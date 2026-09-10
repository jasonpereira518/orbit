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

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contactIdentities, contacts } from "@/db/schema";
import { identityKeysFor, type IdentityInput, type IdentityKey } from "@/lib/duplicates";

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
 * Bring a contact's identity rows in line with its current columns.
 *
 * Returns the owners reported by the claim, so a caller that has just written a contact can
 * see whether any identifier landed on somebody else and merge accordingly.
 */
export async function syncIdentitiesForContact(
  userId: string,
  contactId: string,
  input: IdentityInput,
  source?: string
): Promise<IdentityOwner[]> {
  const wanted = identityKeysFor(input);
  const current = await identitiesForContact(userId, contactId);
  const wantedSet = new Set(wanted.map(keyToken));
  const stale = current
    .filter((c) => !wantedSet.has(keyToken(c)))
    .map((c) => ({ kind: c.kind, value: c.value }));
  if (stale.length) await releaseIdentities(userId, contactId, stale);
  return claimIdentities(userId, contactId, wanted, source);
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

/**
 * Contacts that could not claim an identifier because another contact holds it — i.e. the
 * duplicates that already existed before this table did.
 *
 * Computed rather than stored: a contact stops being contested the moment it is merged, and
 * a stored flag would have to be cleared by every merge path.
 */
export async function findContestedContacts(userId: string, limit = 200) {
  const db = await getDb();
  const rows = await db
    .select({
      contactId: contacts.id,
      ownerContactId: contactIdentities.contactId,
      kind: contactIdentities.kind,
      value: contactIdentities.value,
    })
    .from(contacts)
    .innerJoin(
      contactIdentities,
      and(
        eq(contactIdentities.userId, contacts.userId),
        sql`${contactIdentities.contactId} <> ${contacts.id}`
      )
    )
    .where(
      and(
        eq(contacts.userId, userId),
        // The contact carries this exact identifier, but somebody else owns the row.
        sql`(
          (${contactIdentities.kind} = 'email' AND lower(btrim(${contacts.email})) = ${contactIdentities.value})
          OR (${contactIdentities.kind} = 'linkedin_slug' AND ${contacts.linkedinSlug} = ${contactIdentities.value})
          OR (${contactIdentities.kind} = 'x_handle' AND lower(btrim(${contacts.xHandle})) = ${contactIdentities.value})
        )`
      )
    )
    .limit(limit);

  return rows.filter((r) => r.contactId !== r.ownerContactId);
}

/** Contacts whose ids appear in `ids`, restricted to one user. Small helper for previews. */
export async function contactsByIds(userId: string, ids: string[]) {
  if (!ids.length) return [];
  const db = await getDb();
  return db
    .select()
    .from(contacts)
    .where(and(eq(contacts.userId, userId), inArray(contacts.id, ids)));
}
