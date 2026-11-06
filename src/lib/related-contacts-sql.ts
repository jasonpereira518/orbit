import { sql, type SQL } from "drizzle-orm";

/**
 * The SQL lowering `mentionLikePatterns` is matched against: A-Z, U+212A (KELVIN SIGN) to
 * "k", and U+0130 to "i" + U+0307, every other character left alone. That is the JS
 * `toLowerCase()` at every position where the JS result is ASCII; see
 * `RELATED_SQL_LOWER` in `related-contacts.ts` for why that is exact enough.
 *
 * `lower()` under the "C" collation lowers ASCII letters only, whatever the database's
 * collation, so it is that mapping for A-Z; the two `replace` calls do U+212A and U+0130.
 * It used to be `translate(text, RELATED_SQL_LOWER.from, RELATED_SQL_LOWER.to)`, which
 * gives the same string but runs a per-character set lookup over every note in the account:
 * about 1 s at 5,000 contacts against ~0.1 s for this (LATENCY_PLAN DB-8).
 * `scripts/smoke-related-sql-lower.ts` pins the two to each other.
 */
export function relatedSqlLower(text: SQL): SQL {
  return sql`replace(replace(lower((${text}) COLLATE "C"), chr(8490), 'k'), chr(304), chr(105) || chr(775))`;
}
