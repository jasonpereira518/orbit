import * as Sentry from "@sentry/nextjs";
import type { Instrumentation } from "next";
import { shouldRecordThrottled } from "@/lib/throttle-latch";
import { notifySlack } from "@/lib/ops-notify";
import { toUserFacingError } from "@/lib/errors";

type Args = Parameters<Instrumentation.onRequestError>;

/**
 * Where an uncaught server error goes. Wired as `onRequestError` in `src/instrumentation.ts`.
 *
 * With a Sentry DSN: to Sentry, whose alert rules ("first seen", "more than N in an hour")
 * do the spike detection a Postgres table could only do badly. Without one: a throttled
 * Slack message per route per hour, so the floor is still "someone hears about it".
 *
 * Deliberately NEVER `error_events`. That table is a closed set of named failures with
 * bounded cardinality; "any generic 500" is exactly the line its header draws.
 */
export async function reportRequestError(err: Args[0], request: Args[1], context: Args[2]) {
  if (process.env.SENTRY_DSN) {
    Sentry.captureRequestError(err, request, context);
    return;
  }
  if (!process.env.SLACK_OPS_WEBHOOK_URL) return;
  if (!shouldRecordThrottled(`unhandled:${context.routePath}`)) return;
  const message = toUserFacingError(err, "Unknown error").message.slice(0, 300);
  await notifySlack(
    `:x: *Unhandled ${context.routeType} error* on \`${context.routePath}\` (${request.method} ${request.path})\n${message}`
  ).catch(() => {});
}
