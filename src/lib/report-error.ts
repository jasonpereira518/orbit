import { randomUUID } from "node:crypto";
import { friendlyError, isQuietFailureMessage, isUserFacingError, withReference } from "@/lib/errors";

/**
 * Where a CAUGHT error goes.
 *
 * Uncaught server errors reach Sentry through `onRequestError` (`src/lib/request-errors.ts`).
 * A caught one never does: a catch block that turns a failure into `{ ok: false, error }`
 * or a status row answers the browser with a 200-shaped success and leaves nothing behind
 * but, at best, a `console.error` that Vercel Hobby keeps for an hour. That is how a
 * Stripe checkout failure read as "Could not start checkout" with no trace anywhere.
 *
 * `reportError` is the one call a catch block makes instead:
 *   - to Sentry (when `SENTRY_DSN` is set) with `where`, the account id and context;
 *   - to the log as one greppable line, `[orbit:<where>] ref=<ref> …`, so the reference
 *     can be found in Vercel's runtime logs even without Sentry;
 *   - returning that short reference, for the message the person sees.
 *
 * It never throws — reporting a failure must not become the failure.
 *
 * Sentry is imported on the first report, not with this module. Nearly every page and
 * action imports this file, and a static import put the whole server SDK (~1.7 MB, about
 * a third of a page's server JS) into every route's cold start — to serve a catch block
 * that usually never runs. The event id is generated here and handed to Sentry, so the
 * reference is still synchronous and still names the Sentry event.
 *
 * Server-only in practice (it reads `node:crypto`); nothing in a client bundle imports it.
 */

export type ReportLevel = "error" | "warning";

export type ReportContext = {
  /** A stable, low-cardinality name for the call site: `action.capture.save`, `job.import`. */
  where: string;
  userId?: string | null;
  /** Small, non-secret facts: ids, counts, a provider, a status. Keys naming secrets are dropped. */
  extra?: Record<string, unknown>;
  /** `warning` for best-effort paths that have a backstop; throttled to one per minute per `where`. */
  level?: ReportLevel;
};

const SECRET_KEY = /key|token|secret|password|authorization|cookie|signature/i;
const WARNING_WINDOW_MS = 60_000;
const lastWarning = new Map<string, number>();

type SentrySdk = typeof import("@sentry/nextjs");
let sentry: Promise<SentrySdk> | undefined;

/**
 * `captureContext` rather than top-level `level`/`tags`/…: Sentry reads a hint that has any
 * of those keys as a bare capture context and drops the rest, `event_id` included.
 */
function sendToSentry(err: unknown, eventId: string, level: ReportLevel, ctx: ReportContext, extra?: Record<string, unknown>) {
  // The bundler hands back the module namespace; plain Node (the tsx scripts) hands back
  // the CommonJS build's exports under `default`.
  sentry ??= import("@sentry/nextjs").then((mod) =>
    "captureException" in mod ? mod : (mod as unknown as { default: SentrySdk }).default
  );
  sentry
    .then((Sentry) => {
      Sentry.captureException(err, {
        event_id: eventId,
        captureContext: {
          level,
          tags: { where: ctx.where },
          user: ctx.userId ? { id: ctx.userId } : undefined,
          extra,
        },
      });
    })
    .catch(() => {
      sentry = undefined;
    });
}

function sanitize(extra: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!extra) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra)) {
    if (SECRET_KEY.test(k)) continue;
    out[k] = typeof v === "string" && v.length > 500 ? `${v.slice(0, 500)}…` : v;
  }
  return out;
}

/** Report a caught error. Returns the reference to show the person (8 characters). */
export function reportError(err: unknown, ctx: ReportContext): string {
  const level: ReportLevel = ctx.level ?? "error";
  // 32 hex characters: a valid Sentry event id, whose first 8 are the reference.
  const eventId = randomUUID().replace(/-/g, "");
  const ref = eventId.slice(0, 8);
  try {
    if (level === "warning") {
      const now = Date.now();
      const last = lastWarning.get(ctx.where) ?? 0;
      if (now - last < WARNING_WINDOW_MS) return ref;
      lastWarning.set(ctx.where, now);
    }
    const extra = sanitize(ctx.extra);
    if (process.env.SENTRY_DSN) sendToSentry(err, eventId, level, ctx, extra);
    const who = ctx.userId ? ` user=${ctx.userId}` : "";
    const log = level === "warning" ? console.warn : console.error;
    log(`[orbit:${ctx.where}] ref=${ref}${who}`, err, extra ?? "");
  } catch {
    // Never let reporting fail the caller.
  }
  return ref;
}

/**
 * The message for a catch block that returns a failure as data.
 *
 * - A `UserFacingError` is Orbit's own words about something the person did: shown as is,
 *   not reported.
 * - A failure the person fixes themselves (no key, a refused key, a rate limit, offline):
 *   shown as is, not reported.
 * - Anything else is a fault: reported, and the message carries its reference.
 */
export function reportedFailure(
  err: unknown,
  fallback: string,
  ctx: ReportContext
): { error: string; ref: string | null } {
  if (isUserFacingError(err)) return { error: (err as Error).message, ref: null };
  const message = friendlyError(err, fallback);
  if (isQuietFailureMessage(message)) return { error: message, ref: null };
  const ref = reportError(err, { ...ctx, level: ctx.level ?? (message === fallback ? "error" : "warning") });
  return { error: withReference(message, ref), ref };
}

/** For `.catch(...)` on best-effort work that has a backstop: report, then resolve to `fallback`. */
export function reportAndContinue<T>(ctx: ReportContext, fallback: T) {
  return (err: unknown): T => {
    reportError(err, { level: "warning", ...ctx });
    return fallback;
  };
}

/**
 * For background AI work with a fallback (a deterministic brief, a skipped row): report the
 * failure only when it is a fault. No key, a refused key and a rate limit are the person's
 * configuration, already told to them where they act on it; reporting those would bury the
 * faults. Returns the reference, or null when it stayed quiet.
 */
export function reportUnlessQuiet(err: unknown, ctx: ReportContext): string | null {
  if (isUserFacingError(err)) return null;
  if (isQuietFailureMessage(friendlyError(err, ""))) return null;
  return reportError(err, { level: "warning", ...ctx });
}
