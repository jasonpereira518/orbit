import { getDb } from "@/db";
import { errorEvents } from "@/db/schema";
import { toUserFacingError } from "@/lib/errors";

/**
 * Failures that would otherwise vanish into a `catch {}`.
 *
 * THIS IS NOT A LOGGING FRAMEWORK, and the scoping below is load-bearing. The call sites
 * are a closed set, chosen because each one is (a) currently invisible, (b) not already
 * recorded elsewhere, and (c) bounded in volume by its own nature.
 *
 * Deliberately NOT recorded:
 *  - Embedding failures in `search.ts`. `createEmbedding` / `createEmbeddingsBatch` already
 *    run inside `withUsage`, which writes a `usage_events` row with `success = 0`. Those
 *    `catch {}` blocks sit ABOVE an already-instrumented failure; duplicating them would
 *    make the two tables disagree about how many things broke.
 *  - Vercel Blob being unconfigured, and pgvector being unavailable at boot. Both are
 *    config *facts*, not events, and "once per process" on Vercel means dozens of identical
 *    rows a day. Measure the harm instead, with zero writes:
 *      count(*) FROM contacts WHERE profile_image_url LIKE 'data:%'
 *      count(*) FROM contact_embeddings WHERE embedding_vector IS NULL
 *  - Import and calendar-sync failures. Already persisted in `imports.error_message` and
 *    `calendar_subscriptions.last_sync_error`, and already read by the user inspector.
 *  - Any generic 500 or `toUserFacingError` call. That is the line. Cross it and this
 *    becomes a log table on Postgres with no sampling, no levels and no rotation.
 *
 * No `next/server` import: the call sites below (`search.ts`, `contact-avatar.ts`,
 * `apollo.ts`) sit deep in the import graph and are pulled in by tsx scripts, where that
 * import alone hangs the process — see the note in `src/lib/user-settings.ts`.
 */

/** Dotted call-site ids, same convention as `usage_events.operation`. */
export const ERROR_SOURCES = {
  oauthGmailCallback: "oauth.gmail.callback",
  oauthOutlookCallback: "oauth.outlook.callback",
  searchPgvector: "search.pgvector",
  graphRebuildEmbeddings: "graph.rebuild_embeddings",
  avatarMicrolink: "avatar.microlink",
  apolloSearch: "apollo.search",
  /** A call that outran `SLOW_CALL_THRESHOLD_MS` — see `src/lib/perf-trace.ts`. */
  perfSlow: "perf.slow",
  /**
   * A Stripe Checkout Session could not be created. Bounded by checkout attempts, recorded
   * nowhere else, and the one failure that means nobody can pay — the ops sweep pages on it.
   */
  stripeCheckout: "stripe.checkout",
  /**
   * A Content-Security-Policy violation reported by a browser (`/api/csp-report`). `kind`
   * is the violated directive; the blocked URI lives in context. Throttled per
   * (directive, blocked URI) so one noisy extension is one row an hour, not one a view.
   */
  cspReport: "csp.report",
  /**
   * A feedback submission that could not be stored — a Blob upload the configured store
   * rejected, or a failed insert. Worth a row of its own: the person is told to try again,
   * and without this there is no trace that someone tried to say something and could not.
   */
  feedbackSubmit: "feedback.submit",
} as const;

export type ErrorEventInput = {
  source: string;
  /** Low-cardinality machine code so this groups cleanly. Never a raw message. */
  kind: string;
  userId?: string | null;
  message?: unknown;
  context?: Record<string, unknown>;
};

/**
 * Awaited rather than deferred, and that is affordable precisely because it only fires on
 * failure: the steady-state cost is exactly zero, and the path it adds a write to has
 * already degraded. Never throws — it is only ever called from a path that already failed.
 */
export async function recordErrorEvent(input: ErrorEventInput): Promise<void> {
  try {
    const db = await getDb();
    await db.insert(errorEvents).values({
      source: input.source,
      kind: input.kind,
      userId: input.userId ?? null,
      message: input.message
        ? toUserFacingError(input.message, "Unknown error").message.slice(0, 500)
        : null,
      context: input.context ?? {},
    });
  } catch {
    // Diagnostics must never become the failure.
  }
}

// The latch lives in its own import-free module (see there for why); re-exported so every
// existing call site keeps importing it from here.
export { shouldRecordThrottled } from "@/lib/throttle-latch";
