/**
 * A failed database statement must not carry the values it was writing into any place errors
 * go: the log, Sentry, `error_events`, or Slack.
 *
 * Drizzle's `DrizzleQueryError` message ends with `params: <values>`, and those values are
 * often a note about a named person. `privacy/probe-log-scrub.ts` found the name, a phone
 * number and the note itself surviving the Sentry scrubber (only the email was removed), and
 * the same message reached the console, `error_events.message` and the Slack fallback.
 *
 * Every assertion below uses the real modules; Slack is caught at `fetch`, the console by
 * replacing `console.error`.
 *
 * Run: npx tsx scripts/smoke-error-redaction.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { DrizzleQueryError } from "drizzle-orm/errors";
import { desc } from "drizzle-orm";
import { getDb } from "../src/db";
import { errorEvents } from "../src/db/schema";
import { redactDbError, redactQueryParams } from "../src/lib/db-error-redact";
import { recordErrorEvent } from "../src/lib/error-events";
import { notifyFeedbackSubmitted } from "../src/lib/feedback-notify";
import { reportError } from "../src/lib/report-error";
import { reportRequestError } from "../src/lib/request-errors";
import { scrubSentryEvent } from "../src/lib/sentry-scrub";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const NOTE = "Coffee with Priya Raman (priya.raman@example.test, +1 415 555 0134) — she is interviewing at Stripe and asked me not to tell her manager";
const SENSITIVE = ["Priya Raman", "415 555 0134", "interviewing at Stripe", "priya.raman@example.test"];
const leaks = (text: string) => SENSITIVE.filter((s) => text.includes(s));

function failedInsert() {
  // What the driver throws for a unique violation: the offending value sits in `detail`.
  const pg = Object.assign(new Error('duplicate key value violates unique constraint "memory_chunks_pkey"'), {
    code: "23505",
    detail: `Key (content)=(${NOTE}) already exists.`,
  });
  return new DrizzleQueryError('insert into "memory_chunks" ("user_id", "content") values ($1, $2)', ["user_2smoke", NOTE], pg);
}

/** Captures what `fn` sends to Slack (both the webhook and the bot DM go through fetch). */
async function slackBodies(fn: () => Promise<void>): Promise<string[]> {
  const bodies: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ ok: true, channel: { id: "D1" } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
  return bodies;
}

async function main() {
  console.log("The redaction itself");
  const err = failedInsert();
  const safe = redactDbError(err) as Error;
  check("the SQL is kept", safe.message.includes('insert into "memory_chunks"'));
  check("the values are gone from the message", leaks(safe.message).length === 0, safe.message);
  check("...and from the stack", leaks(safe.stack ?? "").length === 0);
  check("...and from the cause, whose `detail` echoed the row", leaks(JSON.stringify(safe.cause) + String((safe.cause as Error).message)).length === 0 && !("detail" in (safe.cause as object)));
  check("the cause keeps its Postgres code", (safe.cause as { code?: string }).code === "23505");
  check("the caught error itself is not mutated", err.message.includes("Priya Raman"));
  check("an error that is not a failed query passes through untouched", redactDbError(new Error("boom")) instanceof Error && (redactDbError(new Error("boom")) as Error).message === "boom");
  check("a failed-query message wrapped in other text is redacted too", leaks(redactQueryParams(`Import failed: ${err.message}`)).length === 0);

  console.log("\nSentry");
  const event = scrubSentryEvent({
    message: err.message,
    exception: { values: [{ value: err.message }] },
    extra: { params: err.params, nested: { note: `params were: ${NOTE}`, list: [err.message] } },
    spans: [{ description: `GET https://api.example.test/lookup?me=${encodeURIComponent("secret-ticket")}` }],
  });
  check("the exception value carries no values", leaks(event.exception!.values![0].value!).length === 0, event.exception!.values![0].value);
  // Only failed-query text is recognisable; prose a caller puts in `extra` itself is that
  // caller's to leave out (ReportContext says: ids, counts, a provider, a status).
  const nested = event.extra?.nested as { list: string[] };
  check("a failed-query message nested inside an extra is redacted", leaks(nested.list[0]).length === 0, nested.list[0]);
  check("span descriptions are scrubbed", !event.spans![0].description!.includes("secret-ticket"));

  console.log("\nThe log (reportError)");
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}\n${JSON.stringify(a.cause)}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    reportError(err, { where: "smoke.error-redaction", extra: { lastError: err.message } });
  } finally {
    console.error = realError;
  }
  check("the log line names the call site", logged.some((l) => l.includes("[orbit:smoke.error-redaction]")));
  check("the log line carries no values", logged.every((l) => leaks(l).length === 0), logged.join("\n").slice(0, 400));

  console.log("\nerror_events");
  await recordErrorEvent({ source: "smoke", kind: "smoke.redaction", message: err.message });
  const db = await getDb();
  const [row] = await db.select().from(errorEvents).orderBy(desc(errorEvents.createdAt)).limit(1);
  check("the stored message keeps the SQL and drops the values", Boolean(row?.message?.includes("memory_chunks")) && leaks(row?.message ?? "").length === 0, row?.message ?? "");

  console.log("\nSlack");
  process.env.SLACK_OPS_WEBHOOK_URL = "https://hooks.slack.invalid/smoke";
  delete process.env.SENTRY_DSN;
  const unhandled = await slackBodies(() =>
    reportRequestError(
      err,
      { path: "/api/calendar/feedtokensecret123", method: "GET", headers: {} },
      { routerKind: "App Router", routePath: "/api/calendar/[token]", routeType: "route", revalidateReason: undefined, renderSource: undefined, renderType: undefined } as never
    )
  );
  check("the unhandled-error post went out", unhandled.length === 1);
  check("...without the statement's values", leaks(unhandled.join("")).length === 0, unhandled.join("").slice(0, 300));
  check("...or the calendar-feed token in the path", !unhandled.join("").includes("feedtokensecret123"));

  process.env.SLACK_BOT_TOKEN = "xoxb-smoke";
  process.env.SLACK_ALERT_USER_ID = "U0SMOKE";
  const feedback = await slackBodies(() => notifyFeedbackSubmitted({ id: "fb-1", category: "bug", area: "contacts", text: NOTE }));
  const dm = feedback.join("");
  check("the feedback DM went out with a link", dm.includes("/admin/feedback/fb-1"));
  check("...and none of the feedback text", leaks(dm).length === 0, dm.slice(0, 300));

  if (failures > 0) throw new Error(`${failures} error-redaction check(s) failed`);
  console.log("\nAll error-redaction checks passed.");
}

run(main);
