/**
 * The retry engine for outbound webhooks.
 *
 * Its own route rather than a step inside `runOpsSweep`, deliberately: that sweep is the
 * alerting path and is already budgeted to 55 seconds, and folding a drain of unpredictable
 * network latency into it would make Orbit's alert cadence hostage to how slow a customer's
 * endpoint happens to be today.
 *
 * Driven by the existing ten-minute GitHub Actions schedule. Vercel Hobby's single cron slot
 * belongs to `/api/imports/process-stalled`.
 */
import { NextResponse } from "next/server";
import { finishCronRun, startCronRun } from "@/lib/cron-runs";
import { isInternalRequest } from "@/lib/internal-auth";
import {
  drainDueDeliveries,
  emitDueFollowupEvents,
  purgeExpiredIdempotencyKeys,
} from "@/lib/webhooks/dispatch";

export const maxDuration = 60;

/** Idempotency records are a replay guard, not a log. A day is well past any client retry. */
const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

export async function POST(request: Request) {
  // Before any write — an unauthenticated probe must not be able to insert ledger rows.
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const handle = await startCronRun("webhooks.drain");
  try {
    // Queue "this relationship has gone cold" events BEFORE draining, so anything queued here
    // goes out in the same run. Deduplicated per contact per day by its deterministic event
    // id, so a ten-minute sweep does not become 144 identical webhooks.
    const emitted = await emitDueFollowupEvents().catch(() => ({ users: 0, events: 0 }));

    // 40s of a 60s budget, leaving room for the emit above, the ledger write and the purge.
    const stats = await drainDueDeliveries({ budgetMs: 40_000, max: 200 });
    await purgeExpiredIdempotencyKeys(new Date(Date.now() - IDEMPOTENCY_RETENTION_MS)).catch(
      () => null
    );
    await finishCronRun(handle, {
      status: stats.failed > 0 ? "partial" : "ok",
      stats: { ...stats, followupUsers: emitted.users, followupEvents: emitted.events },
    });
    return NextResponse.json({ ok: true, ...stats, ...emitted });
  } catch (err) {
    await finishCronRun(handle, { status: "failed", error: err });
    return NextResponse.json({ error: "drain failed" }, { status: 500 });
  }
}
