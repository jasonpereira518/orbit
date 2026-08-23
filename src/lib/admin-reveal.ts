import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { adminRevealGrants } from "@/db/schema";
import { isAdminUser } from "@/lib/admin";

/**
 * Audited, short-lived permission to read one account's contact and interaction content.
 *
 * WHY THIS SHAPE. The inspector's privacy property has never been "components are careful";
 * it is that the query layer physically does not SELECT the sensitive columns, so no
 * component *can* render a field it never received. Loosening redaction with a UI toggle
 * would throw that away — the data would be on the wire either way, and correctness would
 * depend on every future component remembering to check a flag.
 *
 * So the unmask is a capability object instead. `VerifiedRevealGrant` is branded with a
 * module-private symbol, which means it cannot be constructed anywhere else — not in a
 * component, not in a server action, not by casting an object literal. The only way to get
 * one is `verifyRevealGrant()`, which re-reads the row from the database and re-checks the
 * operator's identity. Queries widen their column allowlist only when handed one.
 *
 * A grant id is therefore not a secret worth protecting: it travels in the URL, and it is
 * worthless to anyone who is not already the admin it was issued to.
 *
 * Scope is one target account, and expiry is short and automatic. There is no global
 * unmask and nothing to remember to switch off.
 */

/** 15 minutes: long enough to work through one support question, short enough to forget. */
export const REVEAL_TTL_MS = 15 * 60 * 1000;

declare const verified: unique symbol;

/**
 * Proof that an unmask was authorised. Cannot be constructed outside this module — the
 * brand is a `unique symbol` that is never exported.
 */
export type VerifiedRevealGrant = {
  readonly [verified]: true;
  readonly grantId: string;
  readonly adminUserId: string;
  readonly targetUserId: string;
  readonly expiresAt: Date;
};

export type RevealGrantSummary = {
  id: string;
  targetUserId: string;
  reason: string;
  expiresAt: Date;
  createdAt: Date;
};

/** Minimum reason length. Longer than `revealContactAction`'s 4 — this covers a whole account. */
export const MIN_REVEAL_REASON = 8;

function brand(row: {
  id: string;
  adminUserId: string;
  targetUserId: string;
  expiresAt: Date;
}): VerifiedRevealGrant {
  return {
    grantId: row.id,
    adminUserId: row.adminUserId,
    targetUserId: row.targetUserId,
    expiresAt: row.expiresAt,
  } as VerifiedRevealGrant;
}

/**
 * Issue a grant. Callers must have already asserted `requireAdminUserId()` — this module
 * takes the admin id rather than resolving it, so the audit row and the grant row are
 * written by the same action, from the same identity, in `src/actions/admin.ts`.
 */
export async function createRevealGrant(input: {
  adminUserId: string;
  targetUserId: string;
  reason: string;
  now?: Date;
}): Promise<RevealGrantSummary> {
  const reason = input.reason.trim();
  if (reason.length < MIN_REVEAL_REASON) {
    throw new Error(
      `Describe why this account's records need to be unmasked (at least ${MIN_REVEAL_REASON} characters).`
    );
  }

  const now = input.now ?? new Date();
  const db = await getDb();
  const [row] = await db
    .insert(adminRevealGrants)
    .values({
      adminUserId: input.adminUserId,
      targetUserId: input.targetUserId,
      reason,
      expiresAt: new Date(now.getTime() + REVEAL_TTL_MS),
    })
    .returning();

  return {
    id: row.id,
    targetUserId: row.targetUserId,
    reason: row.reason,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/**
 * The ONLY way to obtain a `VerifiedRevealGrant`.
 *
 * Re-reads the row and re-checks every condition rather than trusting anything the caller
 * passed: the grant exists, it belongs to this admin, that admin is still on the allowlist,
 * it has not been revoked, it has not expired, and it covers the account being viewed.
 *
 * `isAdminUser` is re-checked here on purpose. Removing an id from ADMIN_USER_IDS should
 * take effect immediately, including for grants issued while it was still present.
 */
export async function verifyRevealGrant(
  grantId: string | null | undefined,
  expect: { adminUserId: string; targetUserId: string },
  now: Date = new Date()
): Promise<VerifiedRevealGrant | null> {
  if (!grantId) return null;
  if (!isAdminUser(expect.adminUserId)) return null;

  const db = await getDb();
  const row = await db.query.adminRevealGrants.findFirst({
    where: eq(adminRevealGrants.id, grantId),
  });

  if (!row) return null;
  if (row.adminUserId !== expect.adminUserId) return null;
  if (row.targetUserId !== expect.targetUserId) return null;
  if (row.revokedAt != null) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;

  return brand(row);
}

/**
 * The grant currently covering this account, if any — used to render the inspector without
 * a grant id in the URL, so a reload does not silently re-mask mid-investigation.
 */
export async function activeRevealGrant(
  adminUserId: string,
  targetUserId: string,
  now: Date = new Date()
): Promise<VerifiedRevealGrant | null> {
  if (!isAdminUser(adminUserId)) return null;

  const db = await getDb();
  const row = await db.query.adminRevealGrants.findFirst({
    where: and(
      eq(adminRevealGrants.adminUserId, adminUserId),
      eq(adminRevealGrants.targetUserId, targetUserId),
      isNull(adminRevealGrants.revokedAt),
      gt(adminRevealGrants.expiresAt, now)
    ),
    orderBy: [desc(adminRevealGrants.createdAt)],
  });

  return row ? brand(row) : null;
}

/** Details for the "unmasked until…" banner. Never returns a grant object. */
export async function describeActiveGrant(
  adminUserId: string,
  targetUserId: string,
  now: Date = new Date()
): Promise<RevealGrantSummary | null> {
  if (!isAdminUser(adminUserId)) return null;

  const db = await getDb();
  const row = await db.query.adminRevealGrants.findFirst({
    where: and(
      eq(adminRevealGrants.adminUserId, adminUserId),
      eq(adminRevealGrants.targetUserId, targetUserId),
      isNull(adminRevealGrants.revokedAt),
      gt(adminRevealGrants.expiresAt, now)
    ),
    orderBy: [desc(adminRevealGrants.createdAt)],
  });

  if (!row) return null;
  return {
    id: row.id,
    targetUserId: row.targetUserId,
    reason: row.reason,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/** Re-mask now. Returns how many live grants were closed, for the audit detail. */
export async function revokeRevealGrants(
  adminUserId: string,
  targetUserId: string,
  now: Date = new Date()
): Promise<number> {
  const db = await getDb();
  const rows = await db
    .update(adminRevealGrants)
    .set({ revokedAt: now })
    .where(
      and(
        eq(adminRevealGrants.adminUserId, adminUserId),
        eq(adminRevealGrants.targetUserId, targetUserId),
        isNull(adminRevealGrants.revokedAt),
        gt(adminRevealGrants.expiresAt, now)
      )
    )
    .returning();
  return rows.length;
}

/**
 * Does this grant cover the account being queried?
 *
 * Every widened column list is gated on this rather than on `grant != null`. Re-checking
 * the target here means a grant for one account can never unmask another, even if a page
 * threads the wrong one through by mistake.
 *
 * SCOPE OF THE CHECK: a `VerifiedRevealGrant` is a *per-request* capability. Its
 * `expiresAt` is the value read from the database at verification time, so this function
 * is a cheap synchronous re-check, not a fresh authorisation. Revocation and expiry are
 * enforced where the object is minted — `verifyRevealGrant` and `activeRevealGrant`, both
 * of which re-read the row — and every request mints a new one. That is the right split:
 * a request that began while the grant was live finishes on it, and the next request is
 * masked again. Do not cache a grant object across requests; nothing here would catch it.
 */
export function grantCovers(
  grant: VerifiedRevealGrant | null | undefined,
  targetUserId: string,
  now: Date = new Date()
): grant is VerifiedRevealGrant {
  if (!grant) return false;
  if (grant.targetUserId !== targetUserId) return false;
  return grant.expiresAt.getTime() > now.getTime();
}

/** Housekeeping: expired grants are dead weight, and the table is append-only. */
export async function pruneExpiredGrants(olderThanDays = 30): Promise<number> {
  const db = await getDb();
  const rows = await db
    .delete(adminRevealGrants)
    .where(
      sql`${adminRevealGrants.expiresAt} < now() - make_interval(days => ${olderThanDays})`
    )
    .returning();
  return rows.length;
}
