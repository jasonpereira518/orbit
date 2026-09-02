import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";

/**
 * Durable trace for a call that ran far longer than it should have.
 *
 * Exists because the Hobby plan keeps runtime logs for about an hour and a function that
 * Vercel kills at its `maxDuration` throws nothing in-process — no error tracker will ever
 * see it. A row in `error_events` is the only record that survives to say WHICH call was
 * slow for WHICH account. Steady-state cost is one `Date.now()` pair; a row is written only
 * past the threshold, so this cannot become the log firehose that file warns about.
 *
 * `now` and `record` are injectable so the smoke test can drive it without a clock or a DB.
 */
export const SLOW_CALL_THRESHOLD_MS = 10_000;

export type SlowCallEvent = { kind: string; ms: number; userId?: string | null };

type TraceOptions = {
  thresholdMs?: number;
  userId?: string | null;
  now?: () => number;
  record?: (event: SlowCallEvent) => Promise<void>;
};

async function recordSlowCall(event: SlowCallEvent) {
  await recordErrorEvent({
    source: ERROR_SOURCES.perfSlow,
    kind: event.kind,
    userId: event.userId ?? null,
    context: { ms: event.ms },
  });
}

export async function traced<T>(
  name: string,
  fn: () => Promise<T>,
  options: TraceOptions = {}
): Promise<T> {
  const now = options.now ?? Date.now;
  const threshold = options.thresholdMs ?? SLOW_CALL_THRESHOLD_MS;
  const record = options.record ?? recordSlowCall;
  const started = now();
  try {
    return await fn();
  } finally {
    const ms = now() - started;
    if (ms >= threshold) {
      // Never let diagnostics become the failure.
      await record({ kind: name, ms, userId: options.userId }).catch(() => {});
    }
  }
}
