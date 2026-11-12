/**
 * Shared plumbing for route handlers: the 429 response and the bounded JSON body reader.
 *
 * Each response/error envelope stays with its caller; only the mechanics live here.
 */
import { NextResponse } from "next/server";
import type { z } from "zod";
import { consumeBucket, isRateLimitedError, type RateLimitedError } from "@/lib/rate-limit";

/** The `{ error }` 429 with `Retry-After` that the plain `/api/*` routes return. */
export function rateLimitedResponse(err: RateLimitedError): NextResponse {
  return NextResponse.json(
    { error: err.message },
    { status: 429, headers: { "Retry-After": String(err.retryAfterSec) } }
  );
}

/**
 * Consume one token from `bucket`. Resolves to the 429 response when limited, or `null` to
 * proceed. Any other failure (a limiter that cannot count) is rethrown, as before.
 */
export async function withRateLimit(
  bucket: Parameters<typeof consumeBucket>[0],
  key: string,
  limits: Parameters<typeof consumeBucket>[2]
): Promise<NextResponse | null> {
  try {
    await consumeBucket(bucket, key, limits);
    return null;
  } catch (err) {
    if (isRateLimitedError(err)) return rateLimitedResponse(err);
    throw err;
  }
}

export type JsonBodyFailure =
  | { kind: "too_large" }
  | { kind: "invalid_json" }
  | { kind: "invalid_schema"; issue: z.core.$ZodIssue | undefined };

/**
 * Read and validate a JSON body. `onError` maps a failure to the caller's own error (it is
 * thrown). `Content-Length` is checked first to refuse cheaply, then the decoded length is
 * re-checked because the header can be absent (chunked) or wrong. `emptyBody`, when given,
 * stands in for an empty body instead of it being a JSON error.
 */
export async function readJsonBody<T>(
  req: Request,
  schema: z.ZodType<T>,
  opts: { maxBytes: number; onError: (failure: JsonBodyFailure) => Error; emptyBody?: unknown }
): Promise<T> {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > opts.maxBytes) throw opts.onError({ kind: "too_large" });
  const raw = await req.text();
  if (raw.length > opts.maxBytes) throw opts.onError({ kind: "too_large" });

  let parsed: unknown;
  try {
    parsed = raw === "" && "emptyBody" in opts ? opts.emptyBody : JSON.parse(raw);
  } catch {
    throw opts.onError({ kind: "invalid_json" });
  }

  const result = schema.safeParse(parsed);
  if (!result.success) throw opts.onError({ kind: "invalid_schema", issue: result.error.issues[0] });
  return result.data;
}
