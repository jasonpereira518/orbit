/**
 * Which server transactions Sentry traces.
 *
 * ALIAS-FREE ON PURPOSE, like `sentry-scrub.ts`: `sentry.server.config.ts` imports this by
 * relative path, before the TS path aliases exist.
 *
 * A flat 10% sampled every request alike, so trace quota scaled with idle tabs rather than
 * with use: every open tab posts a presence beat every 45s and a page-view beacon per
 * navigation, and those are the two most frequent requests the app serves. Neither has
 * ever been worth a trace. Everything else keeps its 10%, and a trace already sampled
 * upstream (an incoming sentry-trace header) is followed rather than cut in half.
 */
export const DEFAULT_TRACE_SAMPLE_RATE = 0.1;

const UNTRACED = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)?\s*\/api\/(presence|track)(\/|\s|$|\?)/;

export function sampleServerTrace(context: {
  name: string;
  inheritOrSampleWith: (fallbackSampleRate: number) => number;
}): number {
  if (UNTRACED.test(context.name)) return 0;
  return context.inheritOrSampleWith(DEFAULT_TRACE_SAMPLE_RATE);
}
