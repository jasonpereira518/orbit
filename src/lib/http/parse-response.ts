import { z } from "zod";

/**
 * Reading a third-party JSON response.
 *
 * `(await res.json()) as T` tells the compiler what the provider is trusted to send; when the
 * provider changes a field, sends an error body with a 200, or returns a list as an object, the
 * mismatch surfaces later as `Cannot read properties of undefined` in code that has nothing to
 * do with the request. `readUpstream` checks the body against a schema where it is read and
 * throws one `UpstreamShapeError` naming the call and the paths that did not match (never the
 * values: a provider body can echo tokens and addresses).
 *
 * It is an ordinary thrown error, so each call site's existing catch — a retry, a `return null`
 * fallback, a reported action failure — handles it like any other provider failure. A body that
 * is not JSON at all still throws the `SyntaxError` `res.json()` always did.
 */
export class UpstreamShapeError extends Error {
  constructor(
    readonly where: string,
    readonly paths: string[]
  ) {
    super(`${where} returned an unexpected response (${paths.join(", ")})`);
    this.name = "UpstreamShapeError";
  }
}

export function parseUpstream<S extends z.ZodType>(schema: S, body: unknown, where: string): z.output<S> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const paths = [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "(root)"))];
  throw new UpstreamShapeError(where, paths);
}

export async function readUpstream<S extends z.ZodType>(res: Response, schema: S, where: string): Promise<z.output<S>> {
  return parseUpstream(schema, await res.json(), where);
}

/** A scalar the code reads with `?.`/`||`: a wrongly typed value is read as absent. */
export const lenientString = z.string().optional().catch(undefined);
export const lenientNumber = z.number().optional().catch(undefined);
export const lenientBoolean = z.boolean().optional().catch(undefined);

/**
 * A list of records where one malformed entry should cost that entry, not the page. The value
 * itself must be an array: a provider that answers with an object where a list belongs has
 * changed shape, and that is worth an error rather than an empty page.
 */
export function lenientList<T extends z.ZodType>(item: T) {
  return z.array(z.unknown()).transform((entries) =>
    entries.flatMap((entry) => {
      const parsed = item.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    })
  );
}
