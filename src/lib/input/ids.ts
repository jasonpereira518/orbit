/**
 * Ids that arrive from a client. A malformed id handed to a `uuid` column comparison makes
 * Postgres throw (`invalid input syntax for type uuid`) rather than find no rows — a 500 for
 * what is plainly "no such thing". Check the shape first and answer the way a missing row
 * would. Pure and dependency-free.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
