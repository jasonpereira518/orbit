/**
 * Shown whenever AI features fail because the user has NO provider key.
 *
 * `isMissingAiApiKeyError` recognises this exact string (call sites run it on text a
 * server action handed back) alongside Orbit's own "No … API key configured" errors — and
 * nothing a provider says. A key that exists and was refused is `AI_KEY_REJECTED_MESSAGE`.
 */
export const MISSING_AI_API_KEY_MESSAGE =
  "Add your AI API key in Settings to use this";

/** A fetch that never reached Orbit. Said plainly, because the caller's own fallback
 *  ("That didn't save") would blame the wrong thing. */
export const OFFLINE_MESSAGE =
  "Couldn’t reach Orbit — check your connection and try again";

/** An abort or a timeout, from the browser or from a provider. */
export const TIMEOUT_MESSAGE = "That took too long — try again in a moment";

/** A provider stream that ended mid-answer. Thrown from `lib/ai.ts`. */
export const AI_INCOMPLETE_MESSAGE = "The AI’s answer got cut off — try again";

/** The labels `lib/ai.ts` passes to `aiProviderErrorMessage`. */
export const AI_PROVIDER_LABELS = ["Gemini", "OpenAI", "Anthropic"] as const;
export type AiProviderLabel = (typeof AI_PROVIDER_LABELS)[number];

export function aiProviderLabel(
  provider: "gemini" | "openai" | "anthropic"
): AiProviderLabel {
  return provider === "gemini"
    ? "Gemini"
    : provider === "openai"
      ? "OpenAI"
      : "Anthropic";
}

/** Orbit's own no-key errors, thrown from `lib/ai.ts` before any provider is called. */
const MISSING_KEY_PATTERNS = [
  /\bno (?:(?:google )?gemini |openai |anthropic )?api key configured\b/i,
  /\bneeds an? (?:openai|gemini|wispr)\b[^.]*\bapi key\b/i,
];

/**
 * Whether `message` means "this account has no AI key". It used to be `/api key/i`, which
 * also matched every provider that REFUSED a key — and Stripe's "Invalid API Key provided",
 * Apollo's and Resend's — so a checkout failure could tell a buyer to add an AI key.
 */
export function isMissingAiApiKeyError(message: string | null | undefined) {
  if (!message) return false;
  const text = message.trim();
  return (
    text === MISSING_AI_API_KEY_MESSAGE || MISSING_KEY_PATTERNS.some((re) => re.test(text))
  );
}

/**
 * A key IS saved and the AI provider refused it. Distinct from the missing-key message on
 * purpose: "add your key" sends someone who already has one to the wrong fix. Keeps the
 * words "API key" so `classifyAiError` still files it as `auth`.
 */
export const AI_KEY_REJECTED_MESSAGE =
  "Your AI provider didn’t accept your API key — check it in Settings";

/**
 * Raw bodies from Gemini ("API key not valid", `API_KEY_INVALID`), OpenAI ("Incorrect API
 * key provided") and Anthropic ("invalid x-api-key", `authentication_error`). Deliberately
 * NOT the generic "invalid api key": that is Stripe's wording, and Apollo's, and a payment
 * or enrichment key is not the AI key.
 */
const PROVIDER_KEY_REJECTED =
  /api key not valid|api_key_invalid|incorrect api key|invalid x-api-key|authentication_error/i;

/** A refused AI key: a raw provider body, or Orbit's own rewrite of one. */
export function isAiKeyRejectedError(message: string | null | undefined) {
  if (!message) return false;
  return PROVIDER_KEY_REJECTED.test(message) || /didn’t accept your api key/i.test(message);
}

/** Next.js's production stand-in for a thrown Server Action message. */
function isNextDigest(message: string) {
  return (
    /specific message is omitted in production/i.test(message) ||
    /an error occurred in the server components render/i.test(message)
  );
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
    if (!msg || isNextDigest(msg)) {
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

/**
 * What a person reads when an AI provider fails — one template per failure kind.
 *
 * Every template KEEPS the word `classifyAiError` keys on ("API key", "rate limit",
 * "timed out", "model"). That is load-bearing, not incidental: `lib/ai.ts` throws the
 * output of `aiProviderErrorMessage`, and `withUsage` in `lib/usage-events.ts`
 * classifies that already-rewritten error for `usage_events.error_kind`. Reword a
 * template without its trigger and that kind silently becomes "other" in telemetry.
 * `other` must, for the same reason, match none of them.
 */
const AI_FAILURE_COPY = {
  auth: (p: string) => `${p} didn’t accept your API key — check it in Settings`,
  rate_limit: (p: string) =>
    `${p} hit its rate limit — give it a moment and try again`,
  timeout: (p: string) => `${p} timed out — try again, or ask something shorter`,
  model_unavailable: (p: string) =>
    `That ${p} model isn’t available — pick another in Settings`,
  other: (p: string) => `${p} couldn’t answer that — try again in a moment`,
} as const;

/**
 * The reference appended to a message whose real cause was reported (`reportError`) or
 * digested (a Server Action throw in production). A person can quote it; the same string
 * is the Sentry event id prefix or the Next.js digest in the server logs.
 */
export function withReference(message: string, ref: string | null | undefined): string {
  const clean = ref?.trim();
  return clean ? `${message} (ref ${clean})` : message;
}

/**
 * Copy for a failure the person can fix themselves and Orbit cannot: no AI key, a
 * provider that refused their key, a provider rate limit, no connection. Reporting these
 * to Sentry would bury real faults under user configuration, so `reportedFailure` passes
 * them through quietly. Everything else that reaches a fallback is unexpected.
 */
export function isQuietFailureMessage(message: string): boolean {
  if (
    message === MISSING_AI_API_KEY_MESSAGE ||
    message === AI_KEY_REJECTED_MESSAGE ||
    message === OFFLINE_MESSAGE
  ) {
    return true;
  }
  return AI_PROVIDER_LABELS.some(
    (label) => message === AI_FAILURE_COPY.auth(label) || message === AI_FAILURE_COPY.rate_limit(label)
  );
}

export function aiProviderErrorMessage(err: unknown, provider: string): string {
  const base = toUserFacingError(err, `${provider} request failed`).message;

  if (/api key|unauthorized|401|invalid.*key/i.test(base)) {
    return AI_FAILURE_COPY.auth(provider);
  }
  if (/rate limit|429|quota|resource.?exhausted/i.test(base)) {
    return AI_FAILURE_COPY.rate_limit(provider);
  }
  if (/timeout|timed out|ETIMEDOUT|AbortError/i.test(base)) {
    return AI_FAILURE_COPY.timeout(provider);
  }
  if (/model|not found|404/i.test(base)) {
    return AI_FAILURE_COPY.model_unavailable(provider);
  }

  // This used to return up to 237 characters of whatever the provider said, which put
  // raw JSON error bodies — and on a bad day request ids — in front of the person.
  return AI_FAILURE_COPY.other(provider);
}

/**
 * Every message Orbit wrote on purpose to be read by a person, so `friendlyError` can
 * pass it through. Exact strings rather than patterns: a template for a label outside
 * `AI_PROVIDER_LABELS` simply falls back to the caller's copy, which fails safe.
 */
const OWN_WORDS = new Set<string>([
  MISSING_AI_API_KEY_MESSAGE,
  AI_KEY_REJECTED_MESSAGE,
  OFFLINE_MESSAGE,
  TIMEOUT_MESSAGE,
  AI_INCOMPLETE_MESSAGE,
  ...AI_PROVIDER_LABELS.flatMap((label) =>
    Object.values(AI_FAILURE_COPY).map((template) => template(label))
  ),
]);

/**
 * A message written on purpose to be read by a person — "Give it a title first",
 * "Connect Gmail before sending". Safe to show verbatim, which `friendlyError` does.
 *
 * Throwing one from a Server Action is NOT enough on its own: Next.js reduces any throw
 * across that boundary to a digest in production, class and all. Wrap the action body in
 * `asActionResult` so it comes back as data instead. Where it is caught on the same side
 * — a loop inside an action, or a client-side throw — `friendlyError` lets it through.
 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

export function isUserFacingError(err: unknown): err is Error {
  // `name` as well as `instanceof`: a second module instance (a test runner, a
  // separately bundled chunk) would otherwise fail the prototype check.
  return err instanceof UserFacingError || (err instanceof Error && err.name === "UserFacingError");
}

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Run a Server Action body so that a `UserFacingError` reaches the person.
 *
 * A thrown message is replaced by a digest in production; a returned value is not. So a
 * `UserFacingError` becomes `{ ok: false, error }`. Anything else is rethrown untouched,
 * so a genuine fault still surfaces as an error and still gets the caller's friendly
 * fallback — this only rescues the messages that were written to be read.
 */
export async function asActionResult<T>(
  fn: () => Promise<T>
): Promise<ActionResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (isUserFacingError(err)) return { ok: false, error: err.message };
    throw err;
  }
}

function rawMessage(err: unknown): string {
  if (err instanceof Error) return err.message?.trim() ?? "";
  if (typeof err === "string") return err.trim();
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    if (typeof record.message === "string") return record.message.trim();
    if (typeof record.error === "string") return record.error.trim();
  }
  return "";
}

/**
 * The message a person should see for a failure. Never the raw `err.message`.
 *
 * `err instanceof Error ? err.message : fallback` — the shape at ~100 toast sites — is
 * wrong in both environments. In production Next.js replaces a thrown Server Action
 * message with a digest, so the person reads a paragraph about Server Components
 * renders and the fallback is dead code. In development the same line shows them raw
 * provider bodies and internal ids. `toUserFacingError` is not the fix: it keeps
 * `err.message` whenever it is non-empty, which is the leak.
 *
 * So this inverts the default. The caller's `fallback` IS the message, and the only
 * things that override it are the few worth saying more specifically: Orbit's own
 * words (`OWN_WORDS`), a missing AI key, a dead connection, a timeout.
 */
export function friendlyError(err: unknown, fallback: string): string {
  if (isUserFacingError(err)) return err.message;
  const raw = rawMessage(err);

  // A digest can still carry the real error as its cause; run that through the same
  // filter rather than trusting it.
  if (raw && isNextDigest(raw)) {
    const cause = (err as { cause?: unknown } | null)?.cause;
    if (cause) return friendlyError(cause, fallback);
    // The digest is the one handle on the real error: Next logs it beside the stack, and
    // `reportRequestError` tags the Sentry event with it. Showing it lets a person quote
    // something support can find, instead of a generic line that leads nowhere.
    const digest = (err as { digest?: unknown } | null)?.digest;
    return typeof digest === "string" ? withReference(fallback, digest) : fallback;
  }

  if (raw && OWN_WORDS.has(raw)) return raw;
  if (raw && isMissingAiApiKeyError(raw)) return MISSING_AI_API_KEY_MESSAGE;
  if (raw && PROVIDER_KEY_REJECTED.test(raw)) return AI_KEY_REJECTED_MESSAGE;

  // Only a TypeError counts: that is what fetch throws for a network failure, and a
  // server message that happens to say "Load failed" must not be mistaken for one.
  if (
    (err instanceof TypeError &&
      /failed to fetch|networkerror|load failed|network error/i.test(raw)) ||
    (typeof navigator !== "undefined" && navigator.onLine === false)
  ) {
    return OFFLINE_MESSAGE;
  }

  const name = err instanceof Error ? err.name : "";
  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    /timed out|ETIMEDOUT/i.test(raw)
  ) {
    return TIMEOUT_MESSAGE;
  }

  return fallback;
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

/**
 * What to show when an OAuth connection comes back from the provider without working.
 *
 * The callback routes put a `reason` in the redirect URL. Two very different things
 * arrive there: an OAuth protocol code from the provider — `access_denied` means the
 * person clicked Cancel on the consent screen — and, before this change, raw
 * `err.message` from a failed token exchange, which then reached a toast verbatim.
 *
 * A cancellation is not a failure. It gets a quiet message rather than a red error, and
 * so is also not filed under "Missed" in the notification center as though something
 * had broken. Everything else goes through `friendlyError`.
 */
export function describeOAuthReason(
  reason: string | null | undefined,
  provider: string
): { cancelled: boolean; message: string } {
  if (reason === "access_denied") {
    return {
      cancelled: true,
      message: `${provider} connection cancelled — connect again whenever you’re ready`,
    };
  }
  return {
    cancelled: false,
    message: friendlyError(reason, `Couldn’t connect ${provider} — try again?`),
  };
}
