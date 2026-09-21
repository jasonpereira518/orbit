/**
 * Turning a stored import failure into something a person can act on.
 *
 * `failImport` persists the raw `err.message`, so what is actually in the database today is
 * Postgres and OAuth prose: "duplicate key value violates unique constraint
 * contacts_user_email_uidx", "invalid_grant", "canceling statement due to statement timeout".
 * That text reaches the history list *and* the notification bell, and it is useless to anyone
 * who did not write the schema.
 *
 * The raw text is kept — three admin surfaces read it and Sentry has the full error via the
 * reference `failImport` appends — and this module is the layer in front of it.
 *
 * ## Why it classifies stored text rather than only new failures
 *
 * Every row already in the database was written before any of this existed. A classifier that
 * only understood a new `errorCode` column would leave that history exactly as unreadable as
 * it is now, so the regex table is the primary path and the stored code is an optimisation
 * over it — precise where we had the error instance in hand, unnecessary everywhere else.
 *
 * Pure and import-free on purpose (bar the equally import-free Drive row copy):
 * `account-alerts.ts` documents itself as having no database import directly or transitively,
 * and the history list is a client component.
 */

import { isDriveRowCopy } from "@/lib/imports/drive-row-copy";

export type ImportFailureCode =
  | "contact_limit"
  | "needs_reconnect"
  | "provider_permission"
  | "rate_limited"
  | "provider_unavailable"
  | "timeout"
  | "bad_file"
  | "row_conflict"
  | "database"
  | "stalled"
  | "ai_key"
  | "unknown";

export type ImportFailureCopy = {
  /** What happened, in one clause. */
  cause: string;
  /** What to do about it. Empty when there is genuinely nothing to do. */
  next: string;
  /** An offer rather than an error — rendered as an action, not in red. */
  fix?: { label: string; href: string };
};

/**
 * One entry per code. Flat literals so `scripts/smoke-import-errors.ts` can read them out of
 * the source text, the way the toast guard reads `TOAST_COPY`.
 *
 * House voice throughout: curly apostrophes, "Couldn’t" never "Could not", never the word
 * "failed", no trailing period, " — " as the one connector.
 */
export const IMPORT_FAILURE_COPY: Record<ImportFailureCode, ImportFailureCopy> =
  {
    contact_limit: {
      cause: "Your plan’s contact limit was reached partway through",
      next: "Everyone up to the limit was imported, and upgrading brings in the rest",
      fix: { label: "See plans", href: "/settings?section=settings-plan" },
    },
    needs_reconnect: {
      cause:
        "The connection to that account expired while the import was running",
      next: "Reconnect the account and start the import again",
    },
    provider_permission: {
      cause: "Orbit didn’t have permission to read everything it needed",
      next: "Reconnect the account and allow access when asked",
    },
    rate_limited: {
      cause: "The other service asked Orbit to slow down",
      next: "Wait a few minutes and start the import again",
    },
    provider_unavailable: {
      cause: "The other service couldn’t be reached",
      next: "That’s usually temporary, so try again shortly",
    },
    timeout: {
      cause: "The import took longer than it was allowed",
      next: "Try again, and split the file into parts if it’s a very large one",
    },
    bad_file: {
      cause: "Part of that file couldn’t be read",
      next: "Export it again and upload the new copy",
    },
    row_conflict: {
      cause: "Some rows clashed with contacts you already have",
      next: "Everything else was imported, and the rest is listed below",
    },
    database: {
      cause: "Orbit couldn’t save part of this import",
      next: "Nothing was lost, so start the import again",
    },
    stalled: {
      cause: "The import stopped partway and couldn’t pick itself back up",
      next: "Upload the file again to import the rest",
    },
    ai_key: {
      cause: "Orbit doesn’t have a working AI key to read those files with",
      next: "Add or fix your AI key in Settings, then start the import again",
      fix: { label: "Open AI settings", href: "/settings?section=settings-ai" },
    },
    unknown: {
      cause: "This import didn’t finish",
      next: "Try it again, and send us the reference below if it keeps happening",
    },
  };

/** Ordered: the first match wins, so the specific patterns come before the broad ones. */
const PATTERNS: { code: ImportFailureCode; test: RegExp }[] = [
  {
    code: "contact_limit",
    test: /contact limit|plan limit|limit reached on your plan/i,
  },
  { code: "stalled", test: /stalled \d+ times|gave up/i },
  {
    code: "ai_key",
    // "AI provider/key/model" (the Drive key-problem copy) and every AI gate refusal in
    // `ai-access-copy.ts`, which say "AI API key" or "own API key".
    test: /\bAI (provider|key|model|API key)\b|\bown API key\b/i,
  },
  {
    code: "needs_reconnect",
    test: /invalid_grant|reauth|token (has been )?(expired|revoked)|refresh token|unauthoriz|\b401\b/i,
  },
  {
    code: "provider_permission",
    test: /insufficient|not granted|missing scope|forbidden|permission|\b403\b/i,
  },
  { code: "rate_limited", test: /rate limit|too many requests|quota|\b429\b/i },
  {
    code: "timeout",
    test: /timeout|timed out|canceling statement|deadline exceeded|etimedout/i,
  },
  {
    code: "row_conflict",
    test: /duplicate key value|unique constraint|violates foreign key|violates not-null/i,
  },
  {
    code: "database",
    test: /value too long|deadlock detected|invalid input syntax|column .* does not exist|neon|postgres|pg_|sql/i,
  },
  {
    code: "provider_unavailable",
    test: /fetch failed|econnreset|econnrefused|enotfound|socket hang up|network|\b5\d\d\b|unavailable|bad gateway/i,
  },
  {
    code: "bad_file",
    test: /parse|malformed|unexpected token|encoding|delimit|no rows|empty/i,
  },
];

/** The reference `withReference` appends, so it can be shown apart from the sentence. */
export function splitReference(message: string | null | undefined): {
  message: string;
  ref: string | null;
} {
  const raw = (message ?? "").trim();
  const match = raw.match(/^([\s\S]*?)\s*\(ref ([^)]+)\)$/);
  if (!match) return { message: raw, ref: null };
  return { message: match[1].trim(), ref: match[2].trim() };
}

export function classifyImportError(
  raw: string | null | undefined,
): ImportFailureCode {
  const { message } = splitReference(raw);
  if (!message) return "unknown";
  for (const { code, test } of PATTERNS) {
    if (test.test(message)) return code;
  }
  return "unknown";
}

/**
 * Classify from the error itself, where there is more to go on than the message.
 *
 * A `ReauthRequiredError` and a Postgres `code` both say precisely what happened, and both are
 * gone by the time the message has been stringified and truncated into the database. Called at
 * throw time; `classifyImportError` is the fallback for everything already stored.
 *
 * Matches on `err.name` rather than importing the error class, so this file stays import-free
 * and therefore safe in a client component.
 */
export function classifyImportFailure(err: unknown): ImportFailureCode {
  if (err instanceof Error && err.name === "ReauthRequiredError")
    return "needs_reconnect";
  // The AI gate said no (no key, allowance used, managed AI down). By name, not instanceof,
  // to stay import-free — and because its copy is prose a regex could drift away from.
  if (err instanceof Error && err.name === "AiAccessError") return "ai_key";

  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string") {
    // 23xxx integrity violation, 57014 query cancelled, 40P01 deadlock, 22xxx data exception.
    if (code.startsWith("23")) return "row_conflict";
    if (code === "57014") return "timeout";
    if (code === "40P01" || code.startsWith("22") || code.startsWith("42"))
      return "database";
  }

  return classifyImportError(
    err instanceof Error ? err.message : String(err ?? ""),
  );
}

export function describeImportFailure(
  code: ImportFailureCode,
): ImportFailureCopy {
  return IMPORT_FAILURE_COPY[code] ?? IMPORT_FAILURE_COPY.unknown;
}

/**
 * The one-line form, for a history row and for the notification bell.
 *
 * Cause plus next step, because a cause with no remedy is just a nicer-sounding dead end.
 */
export function importFailureLine(
  raw: string | null | undefined,
  code?: ImportFailureCode,
): string {
  const copy = describeImportFailure(code ?? classifyImportError(raw));
  return copy.next ? `${copy.cause} — ${copy.next}` : copy.cause;
}

/**
 * One skipped or failed row's reason, for the detail sheet.
 *
 * A reason Orbit wrote itself (the Drive row copy) is already a sentence for a person and
 * passes through unchanged; anything else is stored driver text and goes through the
 * classifier like an import-level failure.
 */
export function importRowProblemLine(
  status: "failed" | "skipped",
  raw: string | null | undefined,
): string {
  if (raw && isDriveRowCopy(raw)) return raw.trim();
  if (raw) return importFailureLine(raw);
  return status === "skipped"
    ? "Nothing in this row to attach to anyone"
    : "Orbit couldn’t save this row";
}

/**
 * The same treatment for a calendar subscription's `last_sync_error`.
 *
 * A separate entry point because its producer (`icsFetchErrorMessage`) writes multi-sentence
 * prose with trailing periods, and because the one failure unique to it — a public Google
 * address where the secret one was needed — has a specific fix worth naming.
 */
export function icsFailureLine(raw: string | null | undefined): string {
  const { message } = splitReference(raw);
  if (!message)
    return "That calendar couldn’t be checked — try removing it and adding it again";
  if (/private-|secret address|basic\.ics|public/i.test(message)) {
    return "That looks like a calendar’s public address — use the secret iCal address instead";
  }
  if (/\b40[13]\b|forbidden|unauthoriz/i.test(message)) {
    return "That calendar refused the connection — check the link is still shared";
  }
  if (/\b404\b|not found/i.test(message)) {
    return "That calendar link no longer works — paste a fresh one";
  }
  // Deliberately not `importFailureLine`: a subscription is a feed Orbit checks on a clock,
  // not a file someone imported, and the import copy's nouns are wrong for it.
  const code = classifyImportError(message);
  if (code === "rate_limited")
    return "That calendar asked Orbit to slow down — it’ll try again shortly";
  if (code === "timeout" || code === "provider_unavailable") {
    return "That calendar couldn’t be reached — Orbit will try again shortly";
  }
  return "That calendar couldn’t be read on the last try — check the link is still shared";
}
