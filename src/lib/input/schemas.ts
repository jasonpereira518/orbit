/**
 * Zod building blocks for Server Action arguments (`defineAction`, FIX_PLAN 3.1).
 *
 * Each one wraps a helper Orbit already trusts, so a schema and a handler can never disagree
 * about what a date, an id or a link is:
 *   - ids        → `isUuid`            (`./ids`)
 *   - dates      → `parseClientDate`   (`./dates`)
 *   - free text  → `cleanText` + `TEXT_LIMITS` (`./text`)
 *   - links      → `safeHttpUrl`       (`@/lib/safe-links`)
 *
 * Check-only unless the name says otherwise: `uuid`, `clientDateField` and `httpUrl` pass the value
 * through untouched, so a handler that already parses its own input behaves exactly as before.
 * `cappedText` is the exception — it IS `cleanText`, for fields whose handler cleans with the
 * same cap (cleaning twice is a no-op).
 *
 * Pure: imported by action modules and pure smoke tests alike.
 */
import { z } from "zod";
import { isUuid } from "@/lib/input/ids";
import { parseClientDate } from "@/lib/input/dates";
import { cleanText, TEXT_LIMITS } from "@/lib/input/text";
import { safeHttpUrl } from "@/lib/safe-links";

export { TEXT_LIMITS };

/** A row id: a UUID string. For columns typed `uuid`, where anything else is a driver 500. */
export const uuid = z.string().refine(isUuid, { message: "Invalid id" });

/** A list of row ids, capped so one call can't name a whole table's worth. */
export function uuidList(max = 1000) {
  return z.array(uuid).max(max);
}

/**
 * A date a client sent — an ISO string, a date-only string, a `Date` or epoch millis — that
 * `parseClientDate` accepts. The value passes through unchanged; the handler still owns the
 * conversion, this only guarantees it will succeed.
 */
export function clientDateField(field = "date") {
  return z
    .union([z.string(), z.date(), z.number()])
    .refine((value) => parseClientDate(value) !== null, {
      message: `That ${field} doesn’t look right`,
    });
}

/** `clientDateField`, also accepting absence: `null`, `undefined` or `""`. */
export function optionalClientDateField(field = "date") {
  return z
    .union([z.string(), z.date(), z.number(), z.null(), z.undefined()])
    .refine(
      (value) =>
        value === null || value === undefined || value === "" || parseClientDate(value) !== null,
      { message: `That ${field} doesn’t look right` }
    )
    .optional();
}

/** Storable text: `cleanText` at `max` (control and invisible characters gone, NFC, capped). */
export function cappedText(max: number) {
  return z.string().transform((value) => cleanText(value, max));
}

/** `cappedText`, passing `null`/`undefined` through. */
export function optionalCappedText(max: number) {
  return z
    .string()
    .nullish()
    .transform((value) => (typeof value === "string" ? cleanText(value, max) : value));
}

/** A string no longer than `max` — a size check for fields the handler stores as typed. */
export function boundedText(max: number) {
  return z.string().max(max);
}

/** An http(s) link (`safeHttpUrl` accepts it). Passed through unchanged. */
export const httpUrl = z
  .string()
  .refine((value) => safeHttpUrl(value) !== null, { message: "That link needs to start with http:// or https://" });

/** `httpUrl`, also accepting absence (`null`, `undefined`, `""`). */
export const optionalHttpUrl = z
  .union([z.string(), z.null(), z.undefined()])
  .refine((value) => !value || !value.trim() || safeHttpUrl(value) !== null, {
    message: "That link needs to start with http:// or https://",
  })
  .optional();

/**
 * Any JavaScript number, `NaN` and `±Infinity` included. `z.number()` refuses those, and an
 * empty number input (`Number("")` is 0, `parseInt("")` is NaN) reaches handlers that already
 * clamp or default it; refusing it here would be stricter than the handler. The generated
 * argument schemas use this; a hand-written schema can still ask for `z.number()`.
 */
export const anyNumber = z.custom<number>((value) => typeof value === "number", {
  message: "Invalid number",
});

/** One of a fixed set of strings. */
export function oneOf<const T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values);
}
