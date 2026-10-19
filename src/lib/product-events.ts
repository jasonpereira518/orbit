import { after } from "next/server";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db";
import { productEvents } from "@/db/schema";
import { isInternalUser } from "@/lib/analytics-internal";
import { reportError } from "@/lib/report-error";
import {
  ACTORS,
  SURFACES,
  eventSchemas,
  eventVersions,
  type EventName,
  type EventProps,
} from "@/lib/product-event-schemas";

/**
 * The one way Orbit records a product event.
 *
 *   track("capture_saved", { capture_job_id, source_kind: "text", people_created: 3, people_updated: 0 })
 *
 * WHY A HELPER AND NOT A RAW INSERT. An event table fills with whatever call sites hand it.
 * The schema for each event lives in `product-event-schemas.ts` and admits ids, enums, counts,
 * booleans and durations only — never text a person wrote — and this function is the only
 * place that checks it. A malformed event THROWS in development and in the smoke suite, where
 * it is a bug to fix, and is DROPPED with a throttled warning in production, where telemetry
 * must never become a user-visible failure.
 *
 * FIRE-AND-FORGET, like `recordUsage`: the write runs in `after()` so it never delays a
 * response, and falls back to a detached promise outside a request (cron, import runners).
 * Use `trackNow` when a test or a critical ordering needs to await the insert.
 *
 * IDEMPOTENT. `id` is the dedupe key. Pass a deterministic one (a job id, a reminder id plus
 * the action) wherever a retry or a React double-invoke could fire the same fact twice; the
 * insert is `ON CONFLICT DO NOTHING`.
 *
 * ACTOR. `user` means a person did it; `system` means something ran on their behalf (cron,
 * webhook, a background job). Activity counts (`intentionalActionsSince`) read only `user`.
 */

export type TrackOptions = {
  userId?: string | null;
  /** The per-tab analytics session id (`pv_sid`), when the caller has one. */
  sessionId?: string | null;
  surface?: (typeof SURFACES)[number];
  actor?: (typeof ACTORS)[number];
  /** When it happened, if not now (an offline queue replaying). Never trusted past five minutes ahead. */
  occurredAt?: Date;
  /** Deterministic dedupe key. Defaults to a fresh uuid. */
  id?: string;
};

export type ProductEventRow = typeof productEvents.$inferInsert;

const MAX_FUTURE_SKEW_MS = 5 * 60_000;

/** Throws in development and under test; callers in production get a silent drop. */
function strict(): boolean {
  return process.env.NODE_ENV !== "production";
}

/** Validate and shape the row. Exported for the smoke tests; nothing else should call it. */
export function buildProductEvent<N extends EventName>(
  name: N,
  props: EventProps<N>,
  options: TrackOptions = {}
): ProductEventRow {
  const schema = eventSchemas[name];
  if (!schema) throw new Error(`track: unknown event "${String(name)}"`);
  const parsed = schema.safeParse(props);
  if (!parsed.success) {
    throw new Error(`track: "${name}" has invalid properties: ${parsed.error.message}`);
  }
  const userId = options.userId ?? null;
  const now = Date.now();
  const at = options.occurredAt && options.occurredAt.getTime() <= now + MAX_FUTURE_SKEW_MS ? options.occurredAt : new Date(now);
  return {
    id: options.id ?? randomUUID(),
    name,
    version: eventVersions[name],
    occurredAt: at,
    userId,
    sessionId: options.sessionId ?? null,
    surface: options.surface ?? "web",
    actor: options.actor ?? "user",
    isInternal: isInternalUser(userId),
    properties: parsed.data as Record<string, unknown>,
  };
}

async function insert(row: ProductEventRow): Promise<void> {
  const db = await getDb();
  await db.insert(productEvents).values(row).onConflictDoNothing({ target: productEvents.id });
}

/** Record an event and wait for the insert. Never throws in production. */
export async function trackNow<N extends EventName>(
  name: N,
  props: EventProps<N>,
  options: TrackOptions = {}
): Promise<void> {
  let row: ProductEventRow;
  try {
    row = buildProductEvent(name, props, options);
  } catch (err) {
    if (strict()) throw err;
    reportError(err, { where: "analytics.track", level: "warning", extra: { name } });
    return;
  }
  try {
    await insert(row);
  } catch (err) {
    reportError(err, { where: "analytics.track.insert", level: "warning", extra: { name } });
  }
}

/** Record an event without blocking the caller. Validation errors still throw in development. */
export function track<N extends EventName>(
  name: N,
  props: EventProps<N>,
  options: TrackOptions = {}
): void {
  let row: ProductEventRow;
  try {
    row = buildProductEvent(name, props, options);
  } catch (err) {
    if (strict()) throw err;
    reportError(err, { where: "analytics.track", level: "warning", extra: { name } });
    return;
  }
  const write = async () => {
    try {
      await insert(row);
    } catch (err) {
      reportError(err, { where: "analytics.track.insert", level: "warning", extra: { name } });
    }
  };
  // `after()` throws outside a request scope; the cron and import runners reach this too.
  try {
    after(write);
  } catch {
    void write();
  }
}
