/**
 * Caught errors are reported, and the person gets a reference — never a bare generic line.
 *
 * `reportError` is what a catch block calls instead of swallowing the error or leaving a
 * `console.error` that disappears with the server. `reportedFailure` is the message a
 * catch block returns as data. This pins the three behaviours that matter:
 *
 *   - a fault is reported (Sentry when a DSN is set, and always one greppable log line)
 *     and the message carries its reference;
 *   - Orbit's own copy (`UserFacingError`) and a failure the person fixes themselves (no
 *     key, a refused key, offline) pass through unreported and unreferenced;
 *   - reporting never throws, never logs a secret-named field, and throttles warnings;
 *   - with a DSN, the Sentry event carries the reference as its id, plus the level, the
 *     `where` tag, the account and the sanitized context. Sentry is imported lazily there,
 *     and a hint with top-level `level`/`tags` silently loses `event_id`, so this is pinned.
 *
 * Also pins `friendlyError`'s digest reference: a Server Action throw in production shows
 * the digest Next logged with the real error.
 *
 * Run: npx tsx scripts/smoke-report-error.ts
 */
import {
  MISSING_AI_API_KEY_MESSAGE,
  UserFacingError,
  friendlyError,
  isQuietFailureMessage,
  withReference,
} from "../src/lib/errors";
import { reportAndContinue, reportError, reportedFailure } from "../src/lib/report-error";
import * as Sentry from "@sentry/nextjs";

let failures = 0;
// Bound before console.error is replaced below, so a FAIL line is never captured as a log.
const printFail = console.error.bind(console);
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    printFail(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

// Capture what the reporter logs instead of letting it hit the terminal.
const logged: string[] = [];
const realError = console.error;
const realWarn = console.warn;
const capture = (...args: unknown[]) => {
  logged.push(args.map((a) => (a instanceof Error ? `Error(${a.message})` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
};
console.error = capture;
console.warn = capture;

const FALLBACK = "Couldn’t start checkout — try again";

// 1. A fault is reported and referenced.
const fault = new Error("StripeAuthenticationError: Invalid API Key provided: sk_test_****1234");
const r1 = reportedFailure(fault, FALLBACK, { where: "smoke.fault", userId: "user_smoke", extra: { plan: "lifetime" } });
const refMatch = /^Couldn’t start checkout — try again \(ref ([0-9a-f]{8})\)$/.exec(r1.error);
check("a fault returns the fallback with an 8-char reference", Boolean(refMatch), r1.error);
check("…and the reference is returned alongside", r1.ref !== null && refMatch?.[1] === r1.ref);
check("…and never the raw provider message", !r1.error.includes("Invalid API Key"));
const line = logged.find((l) => l.startsWith("[orbit:smoke.fault]"));
check("one greppable log line names where, the ref and the user", Boolean(line && line.includes(`ref=${r1.ref}`) && line.includes("user=user_smoke")), line);
check("…and carries the real error for the logs", Boolean(line && line.includes("Invalid API Key")), line);

// 2. Orbit's own words pass through, unreported.
logged.length = 0;
const r2 = reportedFailure(new UserFacingError("Add the recruiter’s name first"), FALLBACK, { where: "smoke.userfacing" });
check("a UserFacingError is shown as written", r2.error === "Add the recruiter’s name first" && r2.ref === null, JSON.stringify(r2));
check("…and is not reported", logged.length === 0, logged.join(" | "));

// 3. Failures the person fixes themselves pass through, unreported.
logged.length = 0;
const r3 = reportedFailure(new Error("No Google Gemini API key configured. Add your own key in Settings."), FALLBACK, { where: "smoke.nokey" });
check("a missing AI key shows the missing-key copy", r3.error === MISSING_AI_API_KEY_MESSAGE && r3.ref === null, JSON.stringify(r3));
check("…and is not reported", logged.length === 0);
check("a refused provider key is quiet", isQuietFailureMessage("Gemini didn’t accept your API key — check it in Settings"));
check("a provider rate limit is quiet", isQuietFailureMessage("OpenAI hit its rate limit — give it a moment and try again"));
check("a provider outage is NOT quiet (it is reported)", !isQuietFailureMessage("Anthropic couldn’t answer that — try again in a moment"));

// 4. Specific-but-unexpected copy (a timeout) is reported at warning level, still referenced.
logged.length = 0;
const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
const r4 = reportedFailure(timeout, FALLBACK, { where: "smoke.timeout" });
check("a timeout keeps its specific copy and gains a reference", /^That took too long — try again in a moment \(ref [0-9a-f]{8}\)$/.test(r4.error), r4.error);

// 5. Secrets never reach the log; warnings are throttled; reporting never throws.
logged.length = 0;
reportError(new Error("boom"), { where: "smoke.secrets", extra: { apiKey: "sk_live_SHOULD_NOT_APPEAR", refreshToken: "1//tok", contactId: "c-1" } });
const secretLine = logged.join(" ");
check("fields named like secrets are dropped", !secretLine.includes("SHOULD_NOT_APPEAR") && !secretLine.includes("1//tok"), secretLine);
check("…other context is kept", secretLine.includes("c-1"));

logged.length = 0;
reportError(new Error("w1"), { where: "smoke.warn", level: "warning" });
reportError(new Error("w2"), { where: "smoke.warn", level: "warning" });
check("a repeated warning from one place is throttled to one line a minute", logged.length === 1, logged.join(" | "));

const circular: Record<string, unknown> = {};
circular.self = circular;
let threw = false;
try {
  reportError(circular, { where: "smoke.weird", extra: { circular } });
  reportError(undefined, { where: "smoke.undefined" });
} catch {
  threw = true;
}
check("reporting odd values never throws", !threw);

const onBackstop = reportAndContinue({ where: "smoke.continue" }, 0);
check("reportAndContinue resolves to its fallback", onBackstop(new Error("kick lost")) === 0);

// 6. friendlyError carries a production digest as the reference.
const digested = Object.assign(new Error("An error occurred in the Server Components render. The specific message is omitted in production builds"), { digest: "517068523" });
check("a digested Server Action error shows the fallback with the digest",
  friendlyError(digested, FALLBACK) === "Couldn’t start checkout — try again (ref 517068523)", friendlyError(digested, FALLBACK));
check("no digest, no reference", friendlyError(new Error("An error occurred in the Server Components render."), FALLBACK) === FALLBACK);
check("withReference ignores an empty ref", withReference(FALLBACK, " ") === FALLBACK);

async function finish() {
  // 7. With a DSN: the event reaches Sentry under the reference, with its context. The DSN is
  // fake; `beforeSend` records the event and drops it, so nothing leaves the machine.
  const sent: Sentry.ErrorEvent[] = [];
  process.env.SENTRY_DSN = "https://public@o0.ingest.sentry.io/0";
  Sentry.init({ dsn: process.env.SENTRY_DSN, beforeSend: (event) => (sent.push(event), null) });
  const sentryRef = reportError(new Error("to sentry"), { where: "smoke.sentry", userId: "user_smoke", extra: { plan: "pro", apiKey: "sk_live_NOPE" } });
  const sentryWarnRef = reportError(new Error("to sentry, softly"), { where: "smoke.sentry.warn", level: "warning" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const event = sent.find((e) => e.tags?.where === "smoke.sentry");
  const warnEvent = sent.find((e) => e.tags?.where === "smoke.sentry.warn");
  check("the Sentry event id starts with the reference the person sees", Boolean(event?.event_id?.startsWith(sentryRef)), `${sentryRef} vs ${event?.event_id}`);
  check("…and carries the level, the account and the context", event?.level === "error" && event.user?.id === "user_smoke" && event.extra?.plan === "pro", JSON.stringify(event?.extra));
  check("…without secret-named fields", !JSON.stringify(event?.extra ?? {}).includes("NOPE"));
  check("a warning reaches Sentry as a warning under its reference", warnEvent?.level === "warning" && Boolean(warnEvent.event_id?.startsWith(sentryWarnRef)));
  delete process.env.SENTRY_DSN;

  console.error = realError;
  console.warn = realWarn;
  if (failures > 0) {
    console.error(`\n${failures} report-error check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll report-error checks passed.");
  process.exit(0);
}

void finish();
