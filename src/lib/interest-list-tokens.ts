import { createHash } from "node:crypto";
import { and, eq, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { interestListSignups } from "@/db/schema";
import { decryptOrNull, encrypt } from "@/lib/crypto";

/**
 * The interest list's two bearer tokens, at rest (audit L-05).
 *
 * `unsubscribe_token` (in every email) and `share_token` (the `?me=` ticket and `?ref=` link)
 * used to be stored in plaintext, so a read of the table was a set of working links. Now each
 * is stored twice, neither of them usable on its own:
 *   - `*_token_hash`, SHA-256, which is what a presented token is looked up by;
 *   - `*_token_encrypted`, AES-GCM under `ENCRYPTION_SECRET`, because Orbit has to put the
 *     same link into later emails (a referral-tier notice, a broadcast, a rejoin welcome).
 *
 * Rows written before v177 still hold the plaintext until `backfillInterestListTokens` (run
 * by the hourly sweep) moves them over; until then lookups also match the plaintext column.
 * The token VALUES never change, so every link already sent keeps working, before and after.
 */

export function hashInterestToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Insert/update columns for a new unsubscribe token. */
export function sealUnsubscribeToken(token: string) {
  return {
    unsubscribeToken: null,
    unsubscribeTokenHash: hashInterestToken(token),
    unsubscribeTokenEncrypted: encrypt(token),
  };
}

/** Insert/update columns for a new share token. */
export function sealShareToken(token: string) {
  return {
    shareToken: null,
    shareTokenHash: hashInterestToken(token),
    shareTokenEncrypted: encrypt(token),
  };
}

/** The row whose unsubscribe token this is, by hash, or by plaintext on a row not yet backfilled. */
export function unsubscribeTokenMatches(token: string): SQL {
  return or(
    eq(interestListSignups.unsubscribeTokenHash, hashInterestToken(token)),
    eq(interestListSignups.unsubscribeToken, token)
  )!;
}

/** The row whose share token this is, by hash, or by plaintext on a row not yet backfilled. */
export function shareTokenMatches(token: string): SQL {
  return or(
    eq(interestListSignups.shareTokenHash, hashInterestToken(token)),
    eq(interestListSignups.shareToken, token)
  )!;
}

/** The selection a caller adds beside its own columns so the tokens can be revealed. */
export const TOKEN_COLUMNS = {
  unsubscribeToken: interestListSignups.unsubscribeToken,
  unsubscribeTokenEncrypted: interestListSignups.unsubscribeTokenEncrypted,
  shareToken: interestListSignups.shareToken,
  shareTokenEncrypted: interestListSignups.shareTokenEncrypted,
};

type TokenFields = {
  unsubscribeToken?: string | null;
  unsubscribeTokenEncrypted?: string | null;
  shareToken?: string | null;
  shareTokenEncrypted?: string | null;
};

export function revealUnsubscribeToken(row: TokenFields): string | null {
  return row.unsubscribeToken ?? decryptOrNull(row.unsubscribeTokenEncrypted);
}

export function revealShareToken(row: TokenFields): string | null {
  return row.shareToken ?? decryptOrNull(row.shareTokenEncrypted);
}

/**
 * A row with its tokens readable, whichever way it stores them. Everything downstream (the
 * ticket, the email links) keeps reading `row.shareToken` / `row.unsubscribeToken`.
 */
export function withRevealedTokens<T extends TokenFields>(row: T): T & { unsubscribeToken: string | null; shareToken: string | null } {
  return { ...row, unsubscribeToken: revealUnsubscribeToken(row), shareToken: revealShareToken(row) };
}

/** Rows moved per call. Bounded so the hourly sweep never spends long here. */
export const TOKEN_BACKFILL_BATCH = 500;

/**
 * Moves pre-v177 rows from plaintext to hash + ciphertext. Same token values, so no link in
 * anyone's inbox changes. Each row is a compare-and-swap on the plaintext it read, so a
 * concurrent rejoin that minted a token is never overwritten. Returns how many it moved.
 */
export async function backfillInterestListTokens(limit = TOKEN_BACKFILL_BATCH): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select({
      id: interestListSignups.id,
      unsubscribeToken: interestListSignups.unsubscribeToken,
      shareToken: interestListSignups.shareToken,
    })
    .from(interestListSignups)
    .where(or(isNotNull(interestListSignups.unsubscribeToken), isNotNull(interestListSignups.shareToken)))
    .limit(limit);
  let moved = 0;
  for (const row of rows) {
    const set = {
      ...(row.unsubscribeToken ? sealUnsubscribeToken(row.unsubscribeToken) : {}),
      ...(row.shareToken ? sealShareToken(row.shareToken) : {}),
    };
    const updated = await db
      .update(interestListSignups)
      .set(set)
      .where(
        and(
          eq(interestListSignups.id, row.id),
          row.unsubscribeToken
            ? eq(interestListSignups.unsubscribeToken, row.unsubscribeToken)
            : sql`${interestListSignups.unsubscribeToken} IS NULL`,
          row.shareToken
            ? eq(interestListSignups.shareToken, row.shareToken)
            : sql`${interestListSignups.shareToken} IS NULL`
        )
      )
      .returning();
    moved += updated.length;
  }
  return moved;
}
