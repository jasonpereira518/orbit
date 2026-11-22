import type { z } from "zod";
import { reportError } from "@/lib/report-error";

/**
 * The input boundary of a Server Action.
 *
 * A Server Action is a public POST endpoint: TypeScript's `input: { label: string }` is a
 * promise the browser is trusted to keep, and `curl` is not. `parseInput` checks the promise
 * against a zod schema before any of the action runs, so a wrong-typed field becomes a
 * returned `{ ok: false, error }` instead of a `TypeError` three calls down — one that the
 * action's catch block would report as a fault and that may already have consumed a rate-limit
 * token or written half a row.
 *
 * It returns the `{ ok: false, error }` shape every action's own result type already includes,
 * so a call site is `if (!parsed.ok) return parsed;`.
 *
 * A rejection is reported at warning level (throttled per `where`), with the paths of the bad
 * fields and never their values. Real people hit these only through a client/schema mismatch,
 * and without the report that would be a silent "that didn't look right" for everyone.
 */
export type ParsedInput<T> = { ok: true; value: T } | { ok: false; error: string };

export const INVALID_INPUT_MESSAGE = "That didn’t look right — refresh the page and try again";

export function parseInput<S extends z.ZodType>(
  schema: S,
  input: unknown,
  where: string
): ParsedInput<z.output<S>> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  reportError(result.error, {
    where: `action.${where}.invalid-input`,
    level: "warning",
    extra: { paths: result.error.issues.map((issue) => issue.path.join(".") || "(root)") },
  });
  return { ok: false, error: INVALID_INPUT_MESSAGE };
}
