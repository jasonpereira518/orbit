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
    if (message) return new Error(message);
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
