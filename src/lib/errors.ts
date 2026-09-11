/** Shown whenever AI features fail because the user has no provider key. */
export const MISSING_AI_API_KEY_MESSAGE =
  "Add your AI API key in Settings to use this feature.";

/**
 * Thrown at the one place that knows a key is absent — `getAiConfig` and its
 * embedding equivalent in `@/lib/ai`. Everything downstream identifies "no key"
 * by this type.
 *
 * It used to be identified by testing the message against `/api key/i`, which
 * also matched the *accurate* "Invalid Gemini API key. Update it in Settings…"
 * that `aiProviderErrorMessage` produces for a rejected key — and rewrote it to
 * "Add your AI API key in Settings." The result was a closed loop: Settings said
 * the key was saved, every AI surface said there wasn't one, and nothing ever
 * named the real problem. A key that is present but bad must keep its own message.
 */
export class MissingAiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingAiKeyError";
  }
}

/**
 * Whether a thrown value means "the user has configured no provider key at all".
 *
 * Takes the error itself, not its message — a message cannot distinguish absent
 * from invalid, and guessing is what caused the loop described above.
 */
export function isMissingAiApiKeyError(err: unknown): boolean {
  if (err instanceof MissingAiKeyError) return true;
  // Unwrap one level: Next wraps action throws, and `toUserFacingError` reads
  // `cause` for exactly that reason.
  const cause = (err as { cause?: unknown } | null | undefined)?.cause;
  return cause instanceof MissingAiKeyError;
}

/**
 * The client-side counterpart, for the one case where the type cannot survive:
 * a Server Action returns `{ ok: false, error: string }`, so the browser only
 * ever sees a message.
 *
 * Matches the exact constant the server normalizes to, rather than sniffing for
 * "api key" anywhere in the text — that looser test is what used to swallow
 * "Invalid Gemini API key. Update it in Settings…" and report a present-but-bad
 * key as a missing one.
 */
export function isMissingAiApiKeyMessage(message: string | null | undefined) {
  if (!message) return false;
  return message.trim() === MISSING_AI_API_KEY_MESSAGE;
}

/**
 * Turn unknown thrown values into Error instances with messages safe to show
 * clients. Next.js production digests opaque / non-Error throws into a useless
 * "Server Components render" message.
 */
export function toUserFacingError(
  err: unknown,
  fallback = "Something went wrong"
): Error {
  // Checked once, against the error itself rather than any message it carries.
  if (isMissingAiApiKeyError(err)) {
    return new Error(MISSING_AI_API_KEY_MESSAGE);
  }

  if (err instanceof Error) {
    const msg = err.message?.trim();
    // Next.js digest wrapper — recover anything useful from cause/name
    if (
      !msg ||
      /specific message is omitted in production/i.test(msg) ||
      /an error occurred in the server components render/i.test(msg)
    ) {
      const cause = (err as Error & { cause?: unknown }).cause;
      if (cause instanceof Error && cause.message.trim()) {
        return new Error(cause.message);
      }
      return new Error(fallback);
    }
    return err;
  }

  if (typeof err === "string" && err.trim()) {
    return new Error(err.trim());
  }

  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    const message =
      (typeof record.message === "string" && record.message) ||
      (typeof record.error === "string" && record.error) ||
      (typeof record.statusText === "string" && record.statusText);
    if (message) {
      return new Error(message);
    }
  }

  return new Error(fallback);
}

export function aiProviderErrorMessage(err: unknown, provider: string): string {
  // Before any message matching: "no key at all" and "the key was rejected" need
  // different sentences, and the missing-key message itself contains "API key",
  // so it would otherwise fall into the invalid-key branch below.
  if (isMissingAiApiKeyError(err)) return MISSING_AI_API_KEY_MESSAGE;

  const base = toUserFacingError(err, `${provider} request failed`).message;

  if (/api key|unauthorized|401|invalid.*key/i.test(base)) {
    return `Invalid ${provider} API key. Update it in Settings or check your server env key.`;
  }
  if (/rate limit|429|quota|resource.?exhausted/i.test(base)) {
    return `${provider} rate limit hit. Wait a moment and try again.`;
  }
  if (/timeout|timed out|ETIMEDOUT|AbortError/i.test(base)) {
    return `${provider} timed out. Try a shorter question or try again.`;
  }
  if (/model|not found|404/i.test(base)) {
    return `${provider} model is unavailable. Pick a different model in Settings.`;
  }

  return base.length > 240 ? `${base.slice(0, 237)}…` : base;
}

/**
 * Stable machine code for an AI provider failure.
 *
 * Mirrors `aiProviderErrorMessage`'s branches, but yields a low-cardinality token instead
 * of prose. `usage_events.error_kind` stores this: the user-facing string embeds provider
 * names, model names and truncated upstream text, which is unqueryable in aggregate.
 */
export type AiErrorKind =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "model_unavailable"
  | "empty_response"
  | "other";

export function classifyAiError(err: unknown): AiErrorKind {
  // Same ordering requirement as `aiProviderErrorMessage`. Kept as "auth" rather
  // than a new kind so existing `usage_events.error_kind` aggregates stay comparable.
  if (isMissingAiApiKeyError(err)) return "auth";

  const base = toUserFacingError(err, "request failed").message;

  if (/^Empty AI response$/i.test(base)) return "empty_response";
  if (/api key|unauthorized|401|invalid.*key/i.test(base)) return "auth";
  if (/rate limit|429|quota|resource.?exhausted/i.test(base)) return "rate_limit";
  if (/timeout|timed out|ETIMEDOUT|AbortError/i.test(base)) return "timeout";
  if (/model|not found|404/i.test(base)) return "model_unavailable";
  return "other";
}

/**
 * A provider has rejected the refresh token itself — the user must reconnect.
 *
 * Distinct from a transport failure on purpose. A provider outage or a missing client
 * secret must never mark accounts as needing reauth; only a token-level rejection should.
 */
export class ReauthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReauthRequiredError";
  }
}

/**
 * Whether an OAuth token-endpoint response means "this grant is dead, reconnect" rather
 * than "try again later". Google and Microsoft both return 400 with an `invalid_grant`
 * error code for a revoked or expired refresh token.
 */
export function isRefreshRejection(status: number, body: string): boolean {
  if (status !== 400 && status !== 401) return false;
  return /invalid_grant|invalid_client|unauthorized_client/i.test(body);
}
