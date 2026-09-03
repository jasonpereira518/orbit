/** Shown whenever AI features fail because the user has no provider key. */
export const MISSING_AI_API_KEY_MESSAGE =
  "Orbit needs an AI key for this — add a free Gemini API key (about a minute).";

export function isMissingAiApiKeyError(message: string | null | undefined) {
  if (!message) return false;
  return /api key/i.test(message);
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
        return new Error(
          isMissingAiApiKeyError(cause.message)
            ? MISSING_AI_API_KEY_MESSAGE
            : cause.message
        );
      }
      return new Error(fallback);
    }
    if (isMissingAiApiKeyError(msg)) {
      return new Error(MISSING_AI_API_KEY_MESSAGE);
    }
    return err;
  }

  if (typeof err === "string" && err.trim()) {
    const msg = err.trim();
    return new Error(
      isMissingAiApiKeyError(msg) ? MISSING_AI_API_KEY_MESSAGE : msg
    );
  }

  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    const message =
      (typeof record.message === "string" && record.message) ||
      (typeof record.error === "string" && record.error) ||
      (typeof record.statusText === "string" && record.statusText);
    if (message) {
      return new Error(
        isMissingAiApiKeyError(message)
          ? MISSING_AI_API_KEY_MESSAGE
          : message
      );
    }
  }

  return new Error(fallback);
}

export function aiProviderErrorMessage(err: unknown, provider: string): string {
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
