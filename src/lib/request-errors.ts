import * as Sentry from "@sentry/nextjs";
import type { Instrumentation } from "next";
import { shouldRecordThrottled } from "@/lib/throttle-latch";
import { notifySlack } from "@/lib/ops-notify";
import { sendSlackDM } from "@/lib/slack-dm";
import { toUserFacingError } from "@/lib/errors";

type Args = Parameters<Instrumentation.onRequestError>;

/**
 * Where an uncaught server error goes. Wired as `onRequestError` in `src/instrumentation.ts`.
 *
 * Sentry (when `SENTRY_DSN` is set) and Slack are independent, not alternatives: Sentry
 * keeps the stack trace for debugging, Slack is "come look at this now" — a solo operator
 * wants both, not a choice. The Slack DM (a bot message to `SLACK_ALERT_USER_ID`, see
 * `slack-dm.ts`) always fires when configured; the webhook fallback only fires when the
 * DM path is NOT configured, so a deploy with neither still gets the old channel-post floor.
 * Throttled per route per hour either way, so a crash loop doesn't flood the channel/DM.
 *
 * Deliberately NEVER `error_events`. That table is a closed set of named failures with
 * bounded cardinality; "any generic 500" is exactly the line its header draws.
 */
export async function reportRequestError(err: Args[0], request: Args[1], context: Args[2]) {
  if (process.env.SENTRY_DSN) {
    Sentry.captureRequestError(err, request, context);
  }

  const dmConfigured = Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_ALERT_USER_ID);
  if (!dmConfigured && !process.env.SLACK_OPS_WEBHOOK_URL) return;
  if (!shouldRecordThrottled(`unhandled:${context.routePath}`)) return;

  const message = toUserFacingError(err, "Unknown error").message.slice(0, 300);
  const text = `:x: *Unhandled ${context.routeType} error* on \`${context.routePath}\` (${request.method} ${request.path})\n${message}`;
  if (dmConfigured) {
    await sendSlackDM(text).catch(() => {});
  } else {
    await notifySlack(text).catch(() => {});
  }
}
